"""The scripted demo (PRD 8.1 and task B1): what happens during the run, at its scenario minute.

seed_scenario.py creates these as pending `Event` nodes and Reset recreates them, so the demo plays the same way
every time. Event types and payloads: PRD section 5, "Events". Minutes are tuned by running it.

How to play it: Reset, then triage the five 05:30 casualties as in TRIAGE (paused), press Play, and triage each
new casualty as it appears (TRIAGE again). Triaged differently, the battery event still stops a loaded UGV if one
exists at its minute (it names a vehicle type, not a vehicle).
"""

# The medic's triage this script was tuned with: casualty id -> (category, mobility)
TRIAGE = {
    "CAS-1": ("T1", "litter"), "CAS-2": ("T3", "ambulatory"), "CAS-3": ("T1", "litter"),
    "CAS-4": ("T3", "ambulatory"), "CAS-5": ("T2", "litter"),
    "CAS-6": ("T1", "litter"), "CAS-7": ("T2", "litter"), "CAS-8": ("T3", "ambulatory"),
}

EVENTS = [
    # Casualties keep coming in during the run (untriaged: the medic triages each on screen). CAS-6: a drone spots a
    # sixth casualty near the collection point (8.1 step 2, without the image yet)
    {"id": "EV-1", "at": "2023-09-12T05:38:00Z", "type": "casualty_reported",
     "payload": {"id": "CAS-6", "lat": 47.4534, "lon": 35.8212, "time_of_injury": "2023-09-12T05:33:00Z",
                 "mist_mechanism": "Drone-dropped grenade", "mist_injuries": "Massive bleed, right groin",
                 "mist_signs": "HR 135, RR 26, pale, drowsy", "mist_treatment": "Wound packing, junctional tourniquet"}},
    # 8.1 step 4: a road on the casualties' way to HP-1 is cratered; missions over it re-route (+~4 min). Not the
    # bridge of 7.9 (1297140381): it is the only link between the front and the rear, so closing it leaves no detour
    {"id": "EV-2", "at": "2023-09-12T05:45:00Z", "type": "road_closed",
     "payload": {"osm_way_id": 1200760570, "reason": "Road cratered"}},
    {"id": "EV-3", "at": "2023-09-12T05:50:00Z", "type": "casualty_reported",
     "payload": {"id": "CAS-7", "lat": 47.4469, "lon": 35.8300, "time_of_injury": "2023-09-12T05:44:00Z",
                 "mist_mechanism": "Mortar blast", "mist_injuries": "Open fracture, left lower leg",
                 "mist_signs": "HR 110, RR 20, alert", "mist_treatment": "Splint, morphine 10 mg"}},
    {"id": "EV-4", "at": "2023-09-12T06:02:00Z", "type": "casualty_reported",
     "payload": {"id": "CAS-8", "lat": 47.4422, "lon": 35.8352, "time_of_injury": "2023-09-12T05:58:00Z",
                 "mist_mechanism": "Small arms fire", "mist_injuries": "Through-and-through wound, left upper arm",
                 "mist_signs": "HR 95, RR 16, alert, walking", "mist_treatment": "Field dressing"}},
    # The edge case: a UGV's battery dies with a casualty on board (UGV-1 with CAS-1, ~2 km short of CCP-C). The
    # casualty is stranded on the road and goes to the top of dispatch; UGV-2 is sent for it as soon as it has
    # delivered CAS-3 (06:09), and the free ambulance is not (stranded casualties wait for a UGV, routing.dispatch)
    {"id": "EV-5", "at": "2023-09-12T06:05:00Z", "type": "battery_depleted",
     "payload": {"vehicle_type": "ugv", "reason": "Battery depleted"}},
    # Engineers fill the crater of EV-2: the road is open again and EV-2 shows as resolved. The other events resolve
    # by themselves: a new casualty once delivered, the flat battery once its casualty is picked up
    {"id": "EV-6", "at": "2023-09-12T06:20:00Z", "type": "road_reopened",
     "payload": {"osm_way_id": 1200760570, "reason": "Crater filled by engineers"}},
]
