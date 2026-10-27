# Shared city cars

Approach a stopped car and press **F / Get In**. Open **Seats & radio** to choose a free seat, see occupants, invite a nearby player, or change access as the driver. Cars have 2, 4, or 8 seats according to their model. A passenger can explicitly **Take the wheel** when the driver seat is empty.

Use WASD, arrows, or the phone joystick to drive. Release controls to brake; input opposite the car's heading brakes and reverses, allowing cars to back out of narrow spaces. Exit with F only when stopped and there is safe ground beside the car. Outdoor roads, courtyards, plazas, and the Neon Garden are available when the vehicle fits. Buildings, garden fences, furniture, pedestrians, parked vehicles, and the river remain solid; cars cannot enter the Casino or Arcade.

The driver selects Everyone, Friends Only (mutual account friends), or Invite Only. Invitations expire after 60 seconds and still require the player to approach the stopped car. Account blocks override access and invitations. A new block stops the car and separates the conflicting occupants when a safe exit is available. Until then, driving remains disabled. Disconnecting releases the driver's seat and stops the car; passengers can exit or take over.

**Car chat** uses the existing message composer and Enter submission, but delivers only to the current occupants, with the existing text filter and account blocks. The driver can sound a rate-limited horn and select one of the three original in-game music tracks. Occupants share the radio station and server start time; playback still respects each listener's saved sound preferences and browser audio permissions. Device clock differences and audio buffering can cause small timing differences.

## Implementation and checks

`city-vehicles.js` owns the shared fleet, exclusive seats, access validation, safe exits, oriented vehicle shapes, steering, acceleration, braking, and reverse. The existing movement controller and prediction use the same physics. `server-city-vehicles.js` attaches the social controls without changing the Casino, Arcade, account, or coin implementations.

`city-world.js` contains the planned building blocks, shared road rectangles, and solid furniture. `city-roads.js` renders those same roads, sidewalks, parking, markings, and street furniture. Buildings and foreground objects are depth-sorted with people and vehicles. Road and sidewalk overlap checks cover every building; collision checks use vehicle dimensions rather than predefined road permissions.

Run `node --test tests/*.test.js` for deterministic movement, collision, access, seat exclusivity, stale input, disconnect, prediction, road-layout, garden, and audio coverage. Multiplayer browser validation should additionally cover concurrent boarding, passenger movement, invitations, driver handoff, a city-to-garden drive, phone portrait/landscape controls, and the existing venue/coin flows. Physical phones and production deployment require separate verification.
