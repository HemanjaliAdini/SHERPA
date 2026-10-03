# The Golden Hours: pitch (reference and template)

> **DRAFT: a base to work on, not the final pitch.** Facts must match the demo in [PRD.md](PRD.md) §8.1. Known
> mismatches to fix: the scene is 5 casualties + 2 UGVs + 2 ambulances (not 12/3/2); voice questions are retrieval
> over ~24 known questions, not a local LLM; branches and time travel are nice-to-haves (§8.5), not promised;
> drone and radio inputs are scripted files, not a vision model (PRD 6.12).

Demo Day: Sunday 4 October, from 13:00. Hacking closes at 12:00.

Mindset: better to be decisive and wrong than to hesitate. Short sentences, look at the jury, let the demo do the talking.

---

## 1. How we're scored

**TuringDB (challenge #4).** What they literally say they want:
- Deep multi-hop queries at speed.
- At least one versioning capability: replaying a past state, branching to simulate an action, or diffing two points in time.
- Bonus: fusing multiple data sources into one graph, and location and time as queryable properties.
- Usable by "an operator, system, or agent for critical operations".

**EDTH (general).** They want to put teams "in a position to continue towards deployment", with challenges that come from real frontline needs.
- **Official judging rubric:** [TO DO: check the platform or ask the organisers]
- **Pitch length:** [TO DO]
- **Who judges:** [TO DO]

**Criteria that always matter in a hackathon pitch:**
1. **Clarity:** everyone understands the problem and the solution.
2. **Working proof:** a live demo beats any slide.
3. **Real impact:** a concrete problem, with numbers.
4. **Team credibility:** why we're the right people.

---

## 2. Criterion → how we cover it

| Criterion | Where it shows in our pitch / demo |
|---|---|
| Fast multi-hop queries | "Who falls outside the golden hour if this bridge goes down?" goes casualty → route → vehicle → hospital. Show the response time on screen: [X ms] |
| Versioning | Route cut → two plans in branches → compare → pick one. And replay the exact moment a decision was made (audit) |
| Data fusion | Drone detections + medic assessments + roads + hospitals in one graph |
| Location and time as queryable properties | Every casualty and every event has a position and a timestamp; the map shows it |
| Operator / agent | Operator interface + a local LLM that answers questions about the scenario |
| Path to deployment | Runs on a laptop, offline; the human sets the priority |
| Clarity | One concrete scene (12 casualties, 3 medics, 2 vehicles) that anyone understands without knowing anything about graphs |
| Working proof | Live demo, not a recorded video (keep a backup video in case it fails) |
| Real impact | Data on preventable deaths and the golden hour (section 3) |
| Credibility | Noo: field medicine and deployable systems. Adolfo: reliable AI that runs locally |


PEOPLE DO NOT REMEMBER WHAT YOU SAY, THEY REMEMBER WHAT YOU MAKE THEM FEEL 

WHY WE ARE DOING THIS? WHY THIS MATTER? THE EMOTIONAL PART

An ucranian guy?

---

## 3. Data for the problem (verified)

- **Most die before reaching a hospital.** Of 4,596 US combat deaths (2001-2011), **87.3%** happened before reaching a medical facility. Of those, **24.3%** were potentially survivable, and in **90.9%** of the survivable ones the cause was haemorrhage. *(Eastridge et al., J Trauma Acute Care Surg, 2012)*
- **Time saves lives, and it's been measured.** In 2009 the US mandated evacuating casualties in Afghanistan within 60 minutes. Median transport time dropped from **90 to 43 minutes**, casualties arriving within the hour went from **24.8% to 75.2%**, mortality fell from **13.7% to 7.6%**, and an estimated **359 lives were saved**. *(Kotwal et al., JAMA Surgery, 2016)*
- **In Ukraine the golden hour often no longer exists.** Drones make evacuation slow and dangerous; there are documented cases of wounded soldiers stuck at the front line for months. *(Press and NGO sources; confirm a concrete figure with Noo and his frontline contact before using a number)*

**The idea that ties the three together:** if you can no longer evacuate faster, you have to evacuate in a better order.

---

## 4. Script (read aloud)

> Bracketed parts get adjusted once we know the pitch length.

**1. Hook**
> A strike. Twelve people on the ground. Three medics. Two vehicles.
> And a clock that started the moment they were hit.
> Who do you go to first? Who do you evacuate first? And to where?
> Today, that decision is made over the radio, on paper, from memory.

**2. Problem**
> Most soldiers who die in combat die before they reach a hospital. In the US data, 87%.
> A quarter of those deaths were potentially survivable.
> And we know time is the difference: when the US forced evacuations under 60 minutes in Afghanistan, mortality almost halved. 359 lives saved.
> But in Ukraine, drones have made that hour impossible. You can't always evacuate faster.

**3. Solution (the twist)**
> So the problem isn't that there aren't enough medics or vehicles.
> The problem is the order. Who you reach first, who you move first, and with what information.
> We don't win by sending more. We win by losing fewer.

**4. Product: live demo**
> This is The Golden Hours.
- A drone detects 12 people → they enter as unassessed casualties.
- The system sends the medics, starting with the densest cluster.
- The medic takes vitals and sets the priority. *"The medic decides. Not the AI."*
- The system assigns vehicles and hospitals with free beds.
- **Key moment:** the bridge goes down. *"In [X] milliseconds, the graph shows who just fell outside the golden hour."* Two plans in branches, compared, one chosen.
- Alerts: *"This plan depends on a detection that's 40 minutes old. Reassess."*
- Audit: *"Every decision is a commit. We can replay exactly what we knew when we made it."*

**5. Why TuringDB**
> This only works because the answers are many hops away: casualty, route, vehicle, hospital, bed. TuringDB answers that in milliseconds, and its versioning gives us something no radio log can: branches to test a plan before committing, and a full audit trail of every decision.
> It runs offline, on a laptop. So it can run at a forward node, not in a cloud.

**6. Market and dual use**
> Every armed force has this problem. And so does every civil emergency: earthquakes, mass shootings, train crashes. Same problem: more casualties than resources, and minutes that matter.

**7. Competition**
> Today the competition is radio, paper and spreadsheets. DARPA is funding a whole challenge on detecting and triaging casualties. We work on the next step: what you do with that information.

**8. Business model** *(hypothesis, one line)*
> We license it to defence medical units and emergency services, per deployment.

**9. Team**
> Noo builds deployable field hospital systems. Adolfo builds AI that runs locally and has to be reliable. [Rest of the team if someone joins.]

**10. Call to action**
> We're looking for three things: partners with real field data, a pilot with a medical unit, and funding to take this to a field test next year.

**11. Close**
> Drones have taken the golden hour away. We can't give the time back. But we can make every minute count.

---

## 5. To do

- [ ] Pitch length and official rubric (platform or organisers).
- [ ] Real query time to quote in the pitch: [X ms].
- [ ] Confirm a concrete Ukraine figure with Noo (and whether his DARPA Triage Challenge contact adds anything for the pitch).
- [ ] Decide who says each block.
- [ ] Record a demo video as a backup in case the live demo fails.
- [ ] Rehearse with a timer at least twice.

---

**Sources**
- Eastridge et al., "Death on the battlefield (2001-2011)", J Trauma Acute Care Surg, 2012: https://journals.lww.com/jtrauma/Fulltext/2012/12005/Death_on_the_battlefield__2001_2011___.10.aspx
- Kotwal et al., "The Effect of a Golden Hour Policy on the Morbidity and Mortality of Combat Casualties", JAMA Surgery, 2016: https://jamanetwork.com/journals/jamasurgery/fullarticle/2446845 (figures via https://www.medicalnewstoday.com/articles/300221)
- "When the Golden Hour Disappears", Dignitas: https://dignitas.fund/blog/when-the-golden-hour-disappears-how-drone-warfare-is-reshaping-battlefield-medicine-in-ukraine/



