"""Routing and mission choice on tiny hand-built road networks (no TuringDB needed)."""
from pytest import approx

from datetime import datetime

from routing import Point, Road, Vehicle, Waiting, best_option, dispatch, route

# Two ways from 1 to 4:
#   short dirt   1 -> 2 -> 4   (2.0 km, UGV cap 18 km/h, ambulance cap 30)
#   long asphalt 1 -> 3 -> 4   (2.4 km, UGV cap 25 km/h, ambulance cap 60)
def network(asphalt_delay: float = 1.0) -> dict[int, list[Road]]:
    return {
        1: [Road(2, 1000, 18, 30, 1.0), Road(3, 1200, 25, 60, asphalt_delay)],
        2: [Road(4, 1000, 18, 30, 1.0)],
        3: [Road(4, 1200, 25, 60, asphalt_delay)],
    }


def test_fast_vehicle_takes_the_longer_but_faster_road():
    path, minutes, km = route(network(), 1, 4, "ugv", 25)
    assert path == [1, 3, 4]
    assert minutes == approx(2.4 / 25 * 60)
    assert km == approx(2.4)


def test_slow_vehicle_is_limited_by_its_own_speed_and_takes_the_short_road():
    path, minutes, _ = route(network(), 1, 4, "ugv", 15)
    assert path == [1, 2, 4]
    assert minutes == approx(2.0 / 15 * 60)


def test_delay_factor_pushes_traffic_off_a_road():
    path, minutes, _ = route(network(asphalt_delay=2.0), 1, 4, "ugv", 25)
    assert path == [1, 2, 4]
    assert minutes == approx(2.0 / 18 * 60)


def test_ambulance_uses_ambulance_caps():
    path, minutes, _ = route(network(), 1, 4, "ambulance", 80)
    assert path == [1, 3, 4]
    assert minutes == approx(2.4 / 60 * 60)


def test_unreachable_returns_none():
    assert route(network(), 4, 1, "ugv", 25) is None  # roads are one-way here


def test_same_junction_is_a_zero_minute_route():
    assert route(network(), 1, 1, "ugv", 25) == ([1], 0.0, 0.0)


# Casualty at junction 4; vehicles start at 1; Role 1 at 5 (3 km on), handover point at 6 (0.5 km on)
def mission_network(threat_on_asphalt: float = 0.0) -> dict[int, list[Road]]:
    roads = network()
    roads[1][1] = Road(3, 1200, 25, 60, 1.0, threat_on_asphalt)
    roads[4] = [Road(5, 3000, 25, 60, 1.0), Road(6, 500, 25, 60, 1.0)]
    return roads


ROLE1 = Point("R1", 5, "role1")
HP = Point("HP", 6, "handover")
POINTS = [ROLE1, HP]


def ugv(vid="UGV", speed=25, range_km=25, battery=100.0, max_threat=0.8):
    return Vehicle(vid, "ugv", 1, speed, range_km, 1, 0, battery, max_threat)


def ambulance(vid="AMB", litter=4, seats=2, max_threat=0.4):
    return Vehicle(vid, "ambulance", 1, 80, 300, litter, seats, 100.0, max_threat)


def test_picks_the_fastest_vehicle_and_ugvs_go_to_the_handover_point():
    slow, fast = ugv("UGV-SLOW", speed=10), ugv("UGV-FAST")
    option = best_option(mission_network(), 4, "litter", [slow, fast], POINTS)
    assert option.vehicle == fast
    assert option.point == HP
    assert option.steps == [1, 3, 4, 6]  # the casualty's junction appears once
    assert option.minutes == approx((2.4 + 0.5) / 25 * 60)
    assert option.pickup_minutes == approx(2.4 / 25 * 60)


def test_ambulances_go_to_role1_and_never_to_a_handover_point():
    option = best_option(mission_network(), 4, "litter", [ambulance()], POINTS)
    assert option.point == ROLE1
    assert best_option(mission_network(), 4, "litter", [ambulance()], [HP]) is None


def test_ugvs_never_go_to_role1():
    assert best_option(mission_network(), 4, "litter", [ugv()], [ROLE1]) is None


def test_litter_casualty_cannot_go_in_a_vehicle_without_litter_space():
    assert best_option(mission_network(), 4, "litter", [ambulance(litter=0)], POINTS) is None


def test_ambulatory_casualty_can_use_a_litter():
    assert best_option(mission_network(), 4, "ambulatory", [ugv()], POINTS) is not None


def test_range_is_scaled_by_battery():
    # the UGV trip to the handover point is 2.9 km
    assert best_option(mission_network(), 4, "litter", [ugv(range_km=2)], POINTS) is None
    assert best_option(mission_network(), 4, "litter", [ugv(range_km=5, battery=50)], POINTS) is None
    assert best_option(mission_network(), 4, "litter", [ugv(range_km=5, battery=60)], POINTS) is not None


def test_roads_above_the_vehicles_max_threat_are_avoided():
    option = best_option(mission_network(threat_on_asphalt=0.7), 4, "litter", [ambulance(max_threat=0.4)], POINTS)
    assert option.steps[:3] == [1, 2, 4]  # round the threatened asphalt road
    option = best_option(mission_network(threat_on_asphalt=0.7), 4, "litter", [ugv(max_threat=0.8)], POINTS)
    assert option.steps[:3] == [1, 3, 4]


def test_casualty_at_a_relay_point_gets_ambulances_only():
    assert best_option(mission_network(), 4, "litter", [ugv()], POINTS, at_relay=True) is None
    option = best_option(mission_network(), 4, "litter", [ugv(), ambulance()], POINTS, at_relay=True)
    assert option.vehicle.type == "ambulance"


def waiting(cid, triage, minute, junction=4, mobility="litter", at_relay=False):
    return Waiting(cid, triage, datetime(2023, 9, 12, 4, minute), junction, mobility, at_relay)


def test_dispatch_priority_order():
    one_vehicle = [ugv()]
    plan = dispatch(mission_network(), [waiting("T3-EARLY", "T3", 0), waiting("T1-LATE", "T1", 30)],
                    one_vehicle, POINTS, {"R1": 4})
    assert [cas.id for cas, _ in plan] == ["T1-LATE"]
    plan = dispatch(mission_network(), [waiting("T1-LATER", "T1", 40), waiting("T1-FIRST", "T1", 10)],
                    one_vehicle, POINTS, {"R1": 4})
    assert [cas.id for cas, _ in plan] == ["T1-FIRST"]


def test_dispatch_skips_untriaged_and_dead():
    plan = dispatch(mission_network(), [waiting("NEW", None, 0), waiting("GONE", "DEAD", 0)],
                    [ugv(), ambulance()], POINTS, {"R1": 4})
    assert plan == []


def test_dispatch_uses_each_vehicle_and_bed_once():
    two_ambulances = [ambulance("AMB-1"), ambulance("AMB-2")]
    plan = dispatch(mission_network(), [waiting("A", "T1", 0), waiting("B", "T1", 5)], two_ambulances,
                    POINTS, {"R1": 1})  # Role 1 has one bed; ambulances cannot use the handover point
    assert [cas.id for cas, _ in plan] == ["A"]
    plan = dispatch(mission_network(), [waiting("A", "T1", 0), waiting("B", "T1", 5)], [ugv("U1"), ugv("U2")],
                    POINTS, {"R1": 0})  # handover points have no beds to run out of
    assert sorted(o.vehicle.id for _, o in plan) == ["U1", "U2"]
