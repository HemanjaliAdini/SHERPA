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
    "CAS-6": ("T1", "litter"), "CAS-7": ("T2", "litter"),
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


# --- Sensor fusion (PRD section 5, "Sensor fusion"; task A2e) --------------------------------------------------
# What the drone (SAR Detection photos: posture, plus what it sees) and the soldier's app (simulated: the video shows
# the real app answering the same) report about each casualty. Each recommendation matches TRIAGE above, so the
# medic accepts it with one click and the tuned run (the flat battery with CAS-1 on board) plays the same. At 05:30
# the reports are fused before Play (events.apply_opening); in the same minute they come after the EV events, so a
# casualty reported by EV-x exists before the drone sees it. The app gives no confidence (fixed 0.9, PRD 6.14).
NEAR = 0.00018  # ~20 m north: the drone's fix on a casualty is not exactly where it was reported


def seen(eid, at, source, finding, answer, lat, lon, confidence=None, casualty=None, photo=None):
    payload = {"source": source, "finding": finding, "answer": answer, "lat": lat, "lon": lon}
    if confidence is not None:
        payload["confidence"] = confidence
    if casualty:
        payload["casualty_id"] = casualty
    if photo:
        payload["media"] = f"/media/sar/{photo}.jpg"
    return {"id": eid, "at": f"2023-09-12T{at}:00Z", "type": "observation", "payload": payload}


FUSION = [
    # 05:30, before Play. CAS-1: lying, bleeding badly -> T1 0.90, litter
    seen("OBS-01", "05:30", "drone", "mobility", "no", 47.4430, 35.8335, 0.9, "CAS-1", "cas-1"),
    seen("OBS-02", "05:30", "app", "bleeding_severe", "yes", 47.4430, 35.8335, casualty="CAS-1"),
    # CAS-2: walking -> T3 0.80 by MITT, ambulatory
    seen("OBS-03", "05:30", "drone", "mobility", "yes", 47.4381, 35.7986, 0.8, "CAS-2", "cas-2"),
    # CAS-3: lying, the drone sees blood, the app says struggling to breathe -> T1 0.90
    seen("OBS-04", "05:30", "drone", "mobility", "no", 47.4440, 35.8485, 0.85, "CAS-3", "cas-3"),
    seen("OBS-05", "05:30", "drone", "bleeding_severe", "yes", 47.4440, 35.8485, 0.7, "CAS-3"),
    seen("OBS-06", "05:30", "app", "breathing_distress", "yes", 47.4440, 35.8485, casualty="CAS-3"),
    # CAS-4: walking -> T3 0.70 by MITT
    seen("OBS-07", "05:30", "drone", "mobility", "yes", 47.4415, 35.8250, 0.7, "CAS-4", "cas-4"),
    # CAS-5: lying, chest, belly or back hurt -> T2 0.90, litter
    seen("OBS-08", "05:30", "drone", "mobility", "no", 47.4395, 35.8450, 0.8, "CAS-5", "cas-5"),
    seen("OBS-09", "05:30", "app", "torso_trauma", "yes", 47.4395, 35.8450, casualty="CAS-5"),
    # 05:38, CAS-6 just reported (EV-1): the drone sees someone lying and bleeding ~20 m off, no casualty id ->
    # associated to CAS-6, not a new casualty -> T1 0.50, litter (the medic accepts T1 now)
    seen("OBS-10", "05:38", "drone", "mobility", "no", 47.4534 + NEAR, 35.8212, 0.8, photo="cas-6"),
    seen("OBS-11", "05:38", "drone", "bleeding_severe", "yes", 47.4534 + NEAR, 35.8212, 0.5),
    # 05:42, a soldier reaches CAS-6 and the app answers "Bleeding badly? yes": T1 0.95 (filmed on the real app)
    seen("OBS-12", "05:42", "app", "bleeding_severe", "yes", 47.4534, 35.8212, casualty="CAS-6"),
    # 05:50, CAS-7 just reported (EV-3), lying: the doctrine does not rank an open fracture -> no recommendation,
    # the medic sets T2
    seen("OBS-14", "05:50", "drone", "mobility", "no", 47.4469 + NEAR, 35.8300, 0.8, photo="cas-7"),
]
EVENTS = EVENTS + FUSION
