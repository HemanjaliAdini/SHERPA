"""Routing and mission choice on tiny hand-built road networks (no TuringDB needed)."""
from pytest import approx

from routing import Point, Road, Vehicle, best_option, route

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


# Casualty at junction 4; vehicles start at 1; points at 5 (Role 1) and 6 (collection point only)
def mission_network() -> dict[int, list[Road]]:
    roads = network()
    roads[4] = [Road(5, 3000, 25, 60, 1.0), Road(6, 500, 25, 60, 1.0)]
    return roads


ROLE1 = Point("R1", 5, ("first_aid", "stabilisation"))
CCP = Point("CCP", 6, ("first_aid",))


def test_picks_the_fastest_vehicle_that_can_carry_and_a_point_that_can_treat():
    slow = Vehicle("UGV-SLOW", "ugv", 1, 10, 25, 1, 0)
    fast = Vehicle("UGV-FAST", "ugv", 1, 25, 25, 1, 0)
    option = best_option(mission_network(), 4, "litter", "stabilisation", [slow, fast], [ROLE1, CCP])
    assert option.vehicle == fast
    assert option.point == ROLE1
    assert option.steps == [1, 3, 4, 5]  # the casualty's junction appears once
    assert option.minutes == approx((2.4 + 3.0) / 25 * 60)


def test_litter_casualty_cannot_go_in_a_vehicle_without_litter_space():
    seats_only = Vehicle("CAR", "ambulance", 1, 80, 300, 0, 4)
    assert best_option(mission_network(), 4, "litter", "first_aid", [seats_only], [ROLE1]) is None


def test_ambulatory_casualty_can_use_a_litter():
    litter_only = Vehicle("UGV", "ugv", 1, 25, 25, 1, 0)
    assert best_option(mission_network(), 4, "ambulatory", "first_aid", [litter_only], [CCP]) is not None


def test_vehicle_out_of_range_is_skipped():
    short_range = Vehicle("UGV", "ugv", 1, 25, 5, 1, 0)  # trip is 5.4 km
    assert best_option(mission_network(), 4, "litter", "stabilisation", [short_range], [ROLE1]) is None
