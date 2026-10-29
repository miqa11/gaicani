# City activities implementation status

Updated 2026-10-29. This is an incomplete implementation, not a production release. Base main: `790d435d7eff54500dbd0459d6a7c8babb8ce6de`. Phases 1–3 form the current review milestone; phases 4–6 are still pending.

Publication preparation: embedded service-key fallbacks and the owner IP address have been removed from server source. See DEPLOYMENT-CONFIG.md for private environment settings required before deployment. The full update remains a draft until phases 4–6 are complete.

## Completed and verified

- Phase 1: authoritative activity lifecycle, discovery interface, account inventory and collections, cooldowns, daily reward cap, idempotent commands, guest reward separation, disconnect cleanup.
- Movement: server-validated sprint stamina and jumping, prediction, remote animation, keyboard and phone controls, collision preservation, no stopping drift.
- Phase 2: fishing with three rarities, bug timing, three treasure trails including cooperative discovery, consent-checked local photography and albums, ordered jumping checkpoints with best times.
- Canvas activity props and animations; phone layout keeps activity controls and stamina clear of garden controls. Completed panels can be dismissed.
- Phase 3: four parcel types with optional timed delivery; real-passenger taxi destination requests, agreed fares and passenger-confirmed payment; bounded vehicle wear, driving efficiency and timed repairs; nonalcoholic bar recipes and opt-in player orders; account-only market purchases and catch sales using server prices, stock and daily earning limits.

Validation: `node --test tests/*.test.js`: 85 passing tests (including runtime-configuration checks). Browser scripts in sibling `../qa-activities/` tested real server movement and gameplay with separate desktop/phone contexts: `exploration.cjs`, `movement.cjs`, `cooperative.cjs`, `ui-controls.cjs`, `ui-live.cjs`, `jobs.cjs`. Cooperative trail completed independently by two real browser sessions, each receiving one souvenir. Photography rechecks opt-in and revoked consent at capture. Jobs browser checks completed a shared free taxi ride, actual driving wear and repair, phone bar preparation, timed delivery, and guest market restrictions. Paid fares and account trades are covered by server tests. No browser exceptions in the completed checks.

Existing Casino, Arcade, standalone games, poker, blackjack and auth source files remain unchanged (ignoring checkout line endings). Existing passenger, driving, collision, garden and audio regression tests pass.

## Remaining work, in order

Complete and test each phase before implementing the next. Future catalog entries are hidden until their server handlers are implemented; they are not playable features yet.

1. Phase 4: races, rhythm battles, hide-and-seek, tag, original-text karaoke, consent-based group photo booth, car cosmetics/showcases, moderated graffiti.
2. Phase 5: citizen assistance, persistent friendship, pets, handcrafted detective cases, scripted autonomous yellow citizens.
3. Phase 6: existing Arcade tournament integration with score validation, queued DJ controls preserving spatial audio, collectibles, animated environment interactions, balancing and final regression testing.
4. Final review and production merge after all phases. Do not report the full update complete before these steps.

Reuse existing car garage/seat system and coin APIs. Guests also exist in the account map with `isGuest: true`; never treat their presence there as registration. New tournament prizes must not trust the existing client-reported arcade scores. Use only original/approved audio. Preserve keyboard Enter submission and local photo privacy.
