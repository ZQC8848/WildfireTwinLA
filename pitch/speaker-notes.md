# WildfireTwinLA pitch: speaker notes

Total 300 s (20 + 30 + 25 + 40 + 20 + 40 + 25 + 25 + 40 + 35). The same text is in each slide's notes in `out/WildfireTwinLA-pitch.pptx`.

## 1. A warning sent isn’t a person reached.

[20 s] During a wildfire, sending a warning is only the beginning. A conversation can confirm that someone received it, or that they need a person. With limited staff, the practical question is whom to contact first. These three cards are simulated outcomes from our demo dispatcher; every resident and phone number is fictional.

Evidence: CAL FIRE's Norte incident page lists a Public Information Hotline, which shows voice still matters. We make no claim that calls beat texts or save lives.

## 2. Real fires. A local decision.

[30 s] Wildfires are burning in Southern California this week: Bryson near Malibu, Peak near Azusa, and Norte in Orange County, our case study. What you see is an after-the-fact replay of Norte on October 16, built from public data: the reported ignition, NASA VIIRS satellite passes and archived NOAA HRRR wind. It is a replay, not a live feed. Bryson and Peak are regional context from CAL FIRE pages; our app only displays Norte.

Source times: CAL FIRE pages retrieved Oct 17, 2026, 7:10–7:19 PM PDT. Norte is led by the Orange County Fire Authority.

## 3. Limited staff. Many households. Who comes first?

[25 s] Our seat is the overnight supervisor of a call line: too many households, too few people. We tackle one part of that problem: ordering outbound outreach. Today every call and text is simulated. A Retell voice agent is the planned delivery path, returning call outcomes to the same queue. We rank by estimated fire arrival, not by who sounds most urgent on the phone.

## 4. Nearby homes become a clear outreach queue.

[40 s, live demo] Our rule is simple and inspectable: the sooner the fire is expected at a home, the sooner we call. The estimate uses distance to the nearest simulated burning cell plus the wind, or the model's own arrival time when it has one. Residents flagged with access needs move up five minutes. Six lines run in parallel; each card shows the call and then its outcome. On the map, every home's status sits above its roof.

Demo: start the Norte replay; open the contact panel; hover queue row 1 to highlight the house; click to fly there; compare with a row further down that has a later arrival time; watch a line card turn into Confirmed safe or No answer.

Numbers are from the fictional 555-01 range. Being farther away never means someone is safe.

## 5. Before the emergency: where should we prepare?

[20 s] The same map has an everyday use. A community planner or Fire Safe Council can explore where preventive treatments might help, before any fire starts. That keeps the tool useful between emergencies, so it is already in place when one comes.

## 6. Test a treatment. Compare the simulated outcome.

[40 s, pre-run result] We drew a fuel break downwind of the Norte ignition and compared it with no treatment and two algorithm plans: same ignition, wind and 8-hour horizon, five simulation runs each. Our $25k break reached 422 buildings against 419 untreated; the greedy plan reached 389 for $52k. All of these differences are inside the run-to-run noise of about 58 buildings, so the table shows approximately zero instead of claiming homes saved. That is the point: planners see the uncertainty, not a promise. Fuel breaks can be crossed by embers, and prescribed burns are for authorized professionals.

This comparison was run before the pitch (GPU, about half a minute); do not launch it live.

## 7. What powers today’s prototype?

[25 s] Today's prototype combines committed real geographic data, public fire observations and archived wind. Satellite detections in the demo come from the replay; live pollers exist in the backend but are not configured. The map knows buildings, not people: every resident contact here is synthetic, and the numbers can never ring a real phone. Community areas are approximations, not official evacuation zones.

## 8. What would an operational deployment need?

[25 s] A real deployment needs verified contact records through opt-in enrollment or an approved agency partnership, agency-approved zones and messages, and independent validation. We are not assuming government phone records are available.

Twist 1, funding: our primary pathway is the USDA Forest Service Community Wildfire Defense Grant, which funds community wildfire protection plans; we would join an eligible community application. The alternative is NSF SBIR, reauthorized through 2031.

Twist 2, going global: fire detections, imagery, elevation and global weather models carry over anywhere. Fuel maps, building footprints, zones, consent and telephony rules need local work. Retell supports Mandarin voice agents. Expanding is more than changing a bounding box.

## 9. No answer does not mean safe.

[40 s] An unanswered call is retried once after three minutes. If it still fails, that household's text moves up the queue. Both steps run in our simulation today. But a delivered text is not an acknowledgement; capturing replies is planned. Unresolved contacts stay visible to the operator. If data goes stale or phone networks fail, we show that uncertainty instead of promising contact.

Terminology: these are ordinary SMS follow-ups, not AMBER Alerts or Wireless Emergency Alerts. Evacuation orders stay with authorized officials, and a help flag is not a promise of rescue.

## 10. One workflow from preparation to outreach.

[35 s] Our contribution is the connection: plan prevention before a fire, then use the same geographic context to organize outreach during one. The operator can see why a household is high in the queue and which contacts remain unresolved.

Working today: real Norte data, the public-data replay, the GPU fire simulator and 64-run forecast, treatment comparison, and the simulated contact pipeline with the map and queue. Simulated or planned: real Retell calls, SMS delivery, reply capture, and a configured live feed. Next step: a small pilot with consenting volunteers.

Responsible use: the tool could be misused to contact people without consent or to overstate model predictions. We limit that with fictional demo data, masked contact details, consent-gated real calls, and labels that separate observations, model outputs and official orders.
