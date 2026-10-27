# Demo brief — the expected change

The feed: `GTFS-EXPRESS-API/sample` (New York City Demo Transit, valid 2026-04-01 → 2027-03-31; services WKD, SAT,
SUN shared by every route, NIT for N1).

**Today**

- B2 (`B2`, 7B4FA8), 257 trips per direction, one pattern each. Direction 0 (towards Lower East Side): … Herald
  Square (`HSQ`) 05:49 > Herald Square / Madison Sq (`B2_0_X4_1`) 05:51 > **Madison Sq (`MAD`) 05:53** > Madison Sq /
  Union Square (`B2_0_X5_1`) 05:54 > Union Square (`USQ`) 05:56 … (trip `B2_WKD_0_001`). Direction 1 (towards Hudson
  Yards): … Union Square 05:41 > Union Square / Madison Sq 05:43 > **Madison Sq 05:45** > Madison Sq / Herald Square
  05:47 > Herald Square 05:49 … (`B2_WKD_1_001`). `MAD` is served by B2 and S1 only.
- F1 (`F1`), on Sundays (`SUN`): 29 departures per direction, every 30 minutes from 07:30 to 21:30.
- B1 (`B1`): direction 0 headsign « Chelsea Market », direction 1 « LaGuardia Terminal B ».

**Expected**

- B2: no stop_time at `MAD` on any B2 trip (514 trips), both directions, every service; every other stop_time of B2
  keeps its times; `MAD` stays in stops.txt (S1 still serves it, S1 untouched).
- F1: the six Sunday trips departing 07:30, 08:00 and 08:30 (three per direction) are gone, with their stop_times;
  every other F1 trip unchanged; the `SUN` service itself untouched (the other routes use it).
- B1: every direction-0 trip has the headsign « Chelsea Market via Grand Central »; direction 1 unchanged.
- No other route changes (S1, S2, S3, B4, B5, B6, N1); no stop created or deleted.

**Checkpoints**

- Reader, « After », B2, a weekday: Madison Sq gone from the grid in both directions, Herald Square and Union Square
  at the same times as « Before ».
- F1 on a Sunday: first departure 09:00 each way; on a Saturday and a weekday, the same departures as « Before ».
- Verdict: the four objectives held; the validator with no new error.
- Traps: removing `MAD` from stops.txt (S1 serves it); shifting B2's other times; deleting the `SUN` service or
  touching the other routes' Sunday trips; changing B1's headsign in both directions.
