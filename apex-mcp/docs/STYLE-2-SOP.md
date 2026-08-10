# Style 2 — MOF AI Avatar (UK) — machine-readable spec

Faithful encoding of the Apex Style 2 SOP for implementation. Source: *Style 2 — MOF AI Avatar SOP · Apex*, 23pp.

Where the SOP is a rule, it is stated here as a rule. Where it is a template, the template is reproduced verbatim, because the exact wording is load-bearing — several phrases ("continue from this exact image", "does NOT pick up or fiddle with the bottle") are what make the generation behave.

---

## 1. The format

A ~20–25s vertical (9:16) video. Three beats:

1. **Shock hook** — avatar reacts. On-screen hook text + music. No voice yet.
2. **Product + demo** — she holds it, then uses it on herself. On-screen benefit text. Voiceover starts here.
3. **CTA** — product to camera, points down. On-screen CTA text.

**Audio:** music throughout; on-screen text carries hook → benefit → CTA; a short voiceover runs over the demo and CTA carrying *one genuine benefit → the deal → tap the basket*.

**NEVER LIP-SYNC.** Every clip is silent by design and the voiceover sits on top. The brain does not expect a mouth to move under narration, so it reads as real. Hand over mouth on the hook, looking at the product on the demo, pointing on the CTA. No talking, no lip movement, in any clip.

Best products: skincare, beauty, eye patches, serums, haircare, grooming — anything usable on herself. Non-beauty → Style 1.

---

## 2. The avatar

Built **once** in ChatGPT image creation and reused forever. That exact image is the identity reference attached to **every** prompt — the scene image and all 7 clips. Only location, outfit, angle and pose change between videos. Her face and identity never do.

Realism levers: shoot close-up (face fills frame), dim/warm/low lighting with minimal grading, natural skin texture and slight imperfections, no over-smoothing. Never use "shot on iPhone" — it bakes phone UI into the image.

*Out of scope for the MCP server — the avatar arrives as a `mediaGenerationId` or an uploaded asset.*

---

## 3. Anti-repetition (account-safety critical)

Near-identical videos trigger the repetitive-content flag that bans accounts. Face stays locked and identical; **room, angle, pose, outfit and crop change every single post.**

Every scene must be a NEW random combination. Even for the same product again: different room style, mirror, outfit, camera angle, pose and product layout. Never repeat a scene already used.

### Room selection by product type

| Product type | Room |
|---|---|
| Skincare / beauty / makeup / haircare | Bathroom |
| Clothing / fashion / shoes | Bedroom (camera pulled BACK for the outfit) |
| Outdoor / garden / fitness | Sunny backyard or patio |
| Home / kitchen | Bright kitchen (leaning on the counter) |
| Else | A realistic room it belongs in |

### Rotation menus — roll one fresh value from each, every run

**Bathroom**
- Style: white subway tile / grey stone / white marble / warm wood / dark charcoal tile / micro-cement / sage-green tile
- Mirror: round LED-lit / rectangular LED-lit / large frameless / arched / plain tiled wall (no mirror)
- Outfit: white ribbed tank / black tank / grey tank / cream waffle robe / lilac robe / blue robe / grey robe (vary item AND colour)
- Camera angle: dead straight-on / very slightly above / very slightly below / a touch off to one side
- Pose: both forearms on the counter / one forearm down + selfie arm extended to the lens / leaning in close with chin near hand
- Lighting: bright window daylight / warm vanity bulbs / mixed daylight + warm / flat even everyday light
- Product cluster: rotate which generic products and their layout (serums, tubes, jars, lipsticks, compact, brushes in a cup, makeup bag, cotton pads, towel)

**Kitchen**
- Setting: bright white modern / warm wood / marble-island / grey handleless / farmhouse with open shelving / small cozy apartment
- Outfit: white ribbed tank / black tank / grey tank / cropped tee / oversized shirt / linen shirt
- Camera angle: as bathroom
- Pose: both forearms leaning on the counter / one forearm down + selfie arm extended / standing close to the counter, chin near hand
- Lighting: bright window daylight / warm kitchen downlights / flat even everyday light / soft daylight
- Foreground cluster: fruit bowl / chopping board / mug of coffee / kettle / plant / glasses / tea towel / utensil pot

**Outdoor**
- Setting: sunny patio with small table / garden lawn with plants and fence / poolside with loungers / wooden deck with potted foliage / balcony with hanging plants / porch steps with greenery
- Outfit: white summer sundress / tank top + denim shorts / cropped tee + shorts / linen shirt over a vest / activewear set / swimsuit + open cover-up (vary item AND colour: white / black / sage / tan / pastel)
- Camera angle: as bathroom
- Pose: leaning forearms on a patio table / sitting on a lounger leaning toward the lens / standing close by the plants / crouched beside a garden bed, selfie arm extended
- Lighting: bright midday sun / warm golden-hour glow / soft overcast even light / dappled light through leaves
- Foreground cluster: cold drink with condensation / sunglasses / sunhat / book / plant pot / folded towel / patio-table bits

**Bedroom** (clothing/fashion only)
- Setting: neutral modern with a made bed / with a full-length mirror / cozy with plants and soft bedding / minimalist / warm-lit with a rattan chair
- Outfit: **she is already wearing the promoted garment from the very first frame** (the fashion exception) — style the rest around it
- Framing: pull the camera BACK so the garment is visible head-to-thigh, or use a full-length mirror. NOT a tight face close-up.
- Camera angle: straight-on / a touch to one side / mirror angle
- Pose: standing showing the outfit / turning to show the back / sitting on the edge of the bed / mirror-selfie stance
- Lighting: soft window daylight / warm bedside lamp / bright even daylight

### Composition constants (keep these; vary everything else)

**Bathroom / kitchen / outdoor:** CLOSE and STRAIGHT-ON, tight close-up so her face + upper chest fill the frame, leaning slightly in, a DENSE prop cluster crammed into the immediate foreground along the bottom. Handheld selfie — selfie arm extended toward the lens (phone NOT visible), other hand over her mouth in shock, eyes widened, looking into the camera. Raw phone-video look, natural skin, no over-smoothing.

**Bedroom (fashion):** pull BACK so the garment is the focus (not a tight face shot); handheld selfie or mirror selfie; natural bedroom light; a real lived-in bedroom softly behind.

### Scene-image rule

The scene image contains **generic everyday props only**. Do NOT include or name the promoted product in the scene image — it first appears in N2. The single exception is clothing, which she wears from the first frame.

Write it as a reposing prompt placing the character from the attached avatar into the chosen room with the rolled details. Photorealistic, vertical 9:16, natural skin texture, real pores, subtle imperfections, no over-smoothing, no beauty filter, no plastic sheen, no blur. Not a mirror selfie, no phone or camera interface visible.

---

## 4. Product form — decide FIRST

The form determines the entire clip structure.

### HANDHELD (skincare, makeup, small gadgets)
She holds it. The standard 7-clip chain applies.

**Count rule:** 1 product = one hand · 2 = one in each hand · 3 = two in one hand, one in the other. Keep the same count through close-up, end-frame and CTA. Never duplicate, add, split or spawn extra products.

**Demo placement — work out WHERE the product goes and demo it THERE. Do not default to the face.**

| Product | Demo area |
|---|---|
| Lip balm / gloss / liner / mask | Her LIPS (never the cheek/face) |
| Eye cream / eye patch | Under-eye |
| Face serum / cream / toner / moisturiser | Face/cheek |
| Body / foot / hand product | That body area |
| Hair product / spray / oil | Her hair |
| Nail product | Her nails |

**Prep form:** cream → a dab on her fingertip; serum → a single drop; pump → a pump on her fingers; spray → bottle aimed at that area, finger on the trigger; razor → held to her cheek/jaw; roller → to her cheek; lip → the applicator/bullet at her lips; eye patch → held near her under-eye. If it cannot be applied on camera (a device or tool), hold/show it and say so in one line at the top.

**Application action:** lip → she swipes it across her LIPS; cream/serum → pats and blends into her skin; spray → her finger PRESSES the trigger and it mists onto that area (not into her palm); razor → glides along her cheek/jaw; roller → glides up her cheekbone; hair → works it into her hair. She does NOT pick up, shake or fiddle with the product.

### LARGE / COUNTERTOP (appliance or device — slushie, coffee maker, air-fryer)
The unit **sits on the counter the whole time**. She leans in, presents it with an open hand, points to it, operates it in place. She NEVER lifts it to her chest or face. The handheld camera STAYS PUT — no push-in, no zoom.

**Keep the unit EXACTLY as it is — do NOT animate it working.** No churn, steam, spin, fill or lights. AI warps appliances that move.

Clip swaps: N2 = unit on the counter, she presents/points (does not hold it), label facing camera. N3 = camera stays put, she rests a hand on the unit and looks at camera; product frozen. N4–N5 = do not animate the machine; show the **result** (an already-filled glass she picks up and sips). N6 = she brings the **result** close to the lens; the unit stays on the counter behind. N7 = holds that result near the lens, points down to bottom-left, soft slight smile.

### WORN (clothing / shoes / accessories) — 3 clips, not 7
She is ALREADY WEARING the item the whole video. She applies nothing to skin.

**TWO reference images:** attach BOTH the locked avatar AND the garment photo, and dress her in the EXACT garment from the photo (match colour, cut, waistband, length). The garment will not appear unless you reference its image and say to swap what she is wearing.

3 clips, 6s each (~18s), built as a Nano-per-pose chain so it plays as one continuous mirror try-on:

- **Nano 1** (seed) = full-body SHOCKED mirror selfie wearing the garment (avatar + garment refs) → **Clip 1 (Veo):** opens shocked (hand over mouth ~1s), lowers her hand into a smile, shows off the FRONT, settles standing front, arm down.
- **Nano 2** = full-body, standing front, smiling, arm down (matches Clip 1's ending pose) → **Clip 2 (Veo):** turns around to show the BACK fit, glancing over her shoulder, settles in a clear back / over-shoulder pose.
- **Nano 3** = full-body back / over-shoulder pose (matches Clip 2's ending) → **Clip 3 (Veo):** turns back to face front, smiles, then clearly extends her arm DOWN and points to the bottom-LEFT corner (big, deliberate, held ~2s) toward the shop link.

Rules: a Nano before EVERY clip, each posed to MATCH the previous clip's ENDING; ONLY Clip 1 has the shock (clips 2 & 3 never go near the mouth); each Veo HOLDS the incoming pose a beat, moves, then SETTLES; camera fixed, phone in the same hand every clip. Mirror selfies flip left/right — confirm the final point lands bottom-LEFT (flip in CapCut if not).

Voiceover across the three: love it → already getting compliments + the material → the discount + CTA. (Shoes/accessories: show them on, an angle, then CTA.)

---

## 5. The 7-clip chain (handheld / countertop)

Alternating Nano (still) and Veo (motion). Each Veo continues from the Nano immediately before it. Attach the locked avatar as identity reference at **every** step.

**Durations:** N1 = 4 seconds. All other clips = 6 seconds.

### N1 — Veo: shock reaction (hook)
> Use the uploaded image as the identity reference — same woman, face identical. Ultra-realistic front-facing smartphone selfie video, close framing, her face dominant in frame. Soft shocked expression: eyes widen, one hand comes up to cover her mouth. At 0–0.4s a fast eye-widen with a quick small head jerk forward; 0.4–1.0s a sharp glance to the left; 1.0–1.6s a sharp glance to the right; then she returns to face the camera holding the shocked expression with subtle natural breathing. Dramatic and scroll-stopping, not subtle. Same warm indoor bathroom lighting. Vertical 9:16, photorealistic, no talking, no lip movement. MAKE THIS A 4-SECOND CLIP (all clips after are 6 seconds).

### N2 — Nano: product-holding image
> Use the uploaded avatar as identity reference, face identical. Ultra-realistic selfie, chest-up, same setting. She holds the product(s) naturally — [1 = one hand / 2 = one in each hand / 3 = two in one hand and one in the other]. All labels clearly facing the camera, true to size. Soft natural smile, direct eye contact. Indoor, photorealistic. No warping of the products or labels.

### N3 — Veo: close-up (continue from N2)
> No talking, no lip movement. Same avatar, identical face. She starts holding the product(s) at chest level, then slowly brings them closer to the camera. Labels stay sharp, no warping. Natural smile, eye contact. Same bathroom. Vertical 9:16, fixed camera.

*Countertop variant:* Continue from N2. Handheld selfie, camera stays exactly where it is — no push-in, no zoom. She simply rests her hand on the machine on the counter and looks into the camera with small, natural movements. Nothing on the machine moves or changes — the contents and screen stay exactly as they are. Same room and lighting. One unit only. No talking, no warping. Vertical 9:16.

### N4 — Nano: demo-prep image (do this BEFORE N5)
> Use the uploaded avatar as identity reference, face identical, same setting. Keep her original age and youthful skin, no added wrinkles or under-eye shadows. She holds the product [dropper bottle / pump / jar] in one hand, and a single small [drop / dab] of the product sits on the index fingertip of her other hand, raised up near her cheek. If it's a 2-piece set, the second product sits on the counter behind her, slightly out of focus. Soft natural smile, looking at the camera. Photorealistic, sharp, product label readable.

*Adapt the area per the demo-placement table — lips for lip products, under-eye for eye products, and so on.*

### N5 — Veo: application (continue from N4)
> No talking, no lip movement. Continue from this exact image — same woman, face identical, same setting, same lighting. Using the fingertip that already has the product on it, she gently pats and blends the product onto her cheek in slow, soft circular motions. Calm natural expression with a slight smile. She does NOT pick up, shake, or fiddle with the bottle — she ONLY blends the product already on her fingertip into her cheek. Static front-facing iPhone perspective. Ultra-realistic UGC, no warping.

**Show ONLY the application and the feel. Do NOT render a visible result, improvement or before/after.**

The two phrases that make it work: *"continue from this exact image"* and *"does NOT pick up or fiddle with the bottle — ONLY blends."*

### N6 — Nano: end-frame CTA image
> Use the uploaded avatar as identity reference, face identical, same setting. Product held very close to camera, filling most of the frame, label sharp and centered, hands holding both sides. Her face visible but softly out of focus behind. Depth of field: product sharp, face blurred. Raw iPhone UGC. Vertical 9:16.

### N7 — Veo: final CTA (continue from N6)
> No talking, no lip movement. Continue from the end-frame image, same avatar/face/bathroom. The product stays in her RIGHT hand at chest level, label forward; she pulls it back slightly so face and product are both visible. Her gaze shifts down to the bottom-left; using her LEFT hand only, she points down at the bottom-left corner in a clear rhythm (point, reset, point, reset). Soft confident smile. Product never switches hands. Static front-facing iPhone. No zoom cuts, no warping.

### Spray / pump products
The clip must show her **finger actually pressing the trigger** as it sprays. Flow loves to make the bottle spray by itself with her hand nowhere near — it looks fake instantly. Add: *"her index finger presses down on the spray trigger as it mists."* Regenerate until the finger is clearly on the trigger.

### Face drift
Feed the exact same base avatar image into every clip. On tight close-ups (N3–N5) Veo drifts and she comes out slightly older or different. Check every clip against the shock frame and regenerate any that do not match. If a close-up keeps drifting, pull the shot back a little — extreme zoom is where the face wanders most.

### Assembly
Shock (N1) → Close-up (N3) → Application (N5) → CTA (N7). N1 is 4 seconds; the product clips are 6 seconds each. Voiceover (~19s) starts at ~4s and runs across N2–N7. Total ≈ 22–24s.

---

## 6. Copy rules

### Deal rule by market — compliance critical

**UK:** state the exact discount % from the listing (e.g. "21% off"). Never a £/$ price. If there is no %, say "voucher" with no number — never invent one.

**US:** NO number anywhere. Say "on sale" / "voucher to claim at checkout" and point to the cart. Never a %, price, "lowest price", or fake scarcity.

### Universal prohibitions

- Benefits stay **experiential** — how it looks/feels IN THE MOMENT (texture, tint, glide, comfort, colour). NEVER a result / improvement / before-after claim ("dark circles look lighter", "wrinkles gone", "lips look fuller"). With an AI avatar a rendered result is a *manipulated visual that overstates performance* and gets the video removed.
- Never medical or absolute claims.
- Never fabricate that "TikTok / someone made a pricing mistake, glitch or error" — it is a normal sale.
- No fake scarcity ("they're discontinuing it") unless actually true.
- No profanity, even censored.

### A) On-screen text — 3 cards, 5 options each

- **HOOK** (over N1 shock): big, bold shock/curiosity, product + the deal, max one emoji. Use these shapes across the five: apology ("I'm so sorry to everyone who bought the [PRODUCT] before this sale…"), "WAIT…", everyone's-grabbing-it, this-is-your-sign, POV.
- **BENEFIT** (over the demo, N4–N5): one real IN-THE-MOMENT benefit (texture / tint / glide / feel), ≤8 words, max one emoji, NOT a result. e.g. "So creamy and cushiony on 👄" (NOT "lips look fuller").
- **CTA** (over the end, N6–N7): restate the deal + tap, under 10 words. UK basket / US cart; US uses "on sale / voucher", never a number.

### B) ElevenLabs voiceover

Runs over N2–N7, starts ~4s in (right after the 4-second shock clip). ONE take.

**LENGTH IS MANDATORY: 70–75 words ≈ 19 seconds read aloud.** Count the words and show the count. Under 70 → add more benefit detail until it reaches 70–75. **A script under 65 words is WRONG — never output a short 20–45 word script.**

Casual, excited, first-person, like talking to a friend. Never an ad read.

Structure: opener ("so this is the [product] everyone's been going on about…" / the hype is real) → TWO genuine experiential benefits → the deal (UK: the %, US: "on sale / voucher") → CTA ("tap the orange basket/cart before the sale ends"). Use … for natural pauses and put ONE word in CAPS for emphasis.

### C) Timing map
Split the voiceover across N2–N3 (reveal), N4–N5 (demo), N6–N7 (CTA).

---

## 7. Voice and assembly

**ElevenLabs** — design the voice once, reuse on every video. UK voice for UK, US for US. Stability ~40–45%; regenerate any flat take.

Voice design prompt (adapt to the avatar):
> Excellent, crystal-clear audio quality. A warm, natural female voice — an attractive British woman in her mid-30s with a soft, slightly bright feminine tone. Relaxed, modern everyday British accent, not posh or put-on. She speaks at a natural conversational pace, casual and candid like she's excitedly telling a close friend about something she loves — genuine and upbeat, with subtle natural inflections and easy pauses. Never robotic, never corporate, never an ad read. Effortlessly real and human.

**CapCut** — stitch Shock → Close-up → Application → CTA; music across the whole video; on-screen text HOOK over the shock, BENEFIT over the demo, CTA over the end; voiceover over demo/CTA with the music ducked under the voice; captions matching the voiceover word-for-word; export 9:16.

---

## 8. AI label — required

A synthetic face makes the **AI-generated content label mandatory on every post.** Missing it (or #AIGC) risks a permanent ban for undisclosed AI content.

- Turn ON: More options → AI-generated content → on.
- Hashtags, #AIGC last: `#tiktokshopuk #dealdrops #tiktokmademebuyit #weekendsale #AIGC`
- Confirm the post shows the "Creator labeled as AI-generated" tag.

---

## 9. Final checks before posting

- Spray/pump: her finger is on the trigger when it sprays.
- US accounts: no discount %, price, or number anywhere.
- Face consistency: same locked avatar across every clip, no drift.
- Hairstyle consistent: same hair (up OR down) in every clip — a bun in one and down in the next reads as different days.
- On-screen text spellcheck: read every card aloud; watch for cut-off words where an emoji pushed one out ("21% of" instead of "21% off") and typos.
- Product labels sharp and unwarped when held close.
- Real benefit present — the video actually shows/explains what the product does.
- No before/after or rendered result.
- Discount is a % / voucher matching the live listing — no hard £/$ price, no fake scarcity.
- Voiceover has a benefit, not just a CTA.
- AIGC label ON + #AIGC in the caption.
- Different room / angle / pose / outfit / product from the last few posts.

---

## 10. Reference standard

- Beauty, lip product (demo on the LIPS) → Medicube Pink Collagen Balm
- Beauty, eye cream (demo on the UNDER-EYE) → Dr.Melaxin Dark Spot Eye Cream. *This one was pulled by TikTok for a rendered result — the cautionary example.*
- Kitchen / countertop appliance → slushie machine; product stays put, demo shows the finished drink
- Clothing / fashion → Halara Crossover Leggings; the 3-clip mirror try-on
