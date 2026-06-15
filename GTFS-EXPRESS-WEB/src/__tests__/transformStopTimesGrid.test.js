import { describe, expect, it } from "vitest";
import { transformStopTimesToGrid } from "../utils/transformStopTimesGrid";

describe("transformStopTimesToGrid", () => {
  it("builds one grid row per stop with its times in feed order", () => {
    const grid = transformStopTimesToGrid(
      [
        { stop_id: "S1", arrival_time: "08:00:00", departure_time: "08:01:00" },
        { stop_id: "S1", arrival_time: "09:00:00", departure_time: "09:01:00" },
        { stop_id: "S2", arrival_time: "08:10:00", departure_time: "08:11:00" },
      ],
      [
        { stop_id: "S1", stop_name: "Gare Centrale" },
        { stop_id: "S2", stop_name: "Mairie" },
      ],
    );

    expect(Object.keys(grid)).toEqual(["S1", "S2"]);
    expect(grid.S1.stop_name).toBe("Gare Centrale");
    expect(grid.S1.times).toEqual([
      { arrival_time: "08:00:00", departure_time: "08:01:00" },
      { arrival_time: "09:00:00", departure_time: "09:01:00" },
    ]);
    expect(grid.S2.times).toHaveLength(1);
  });

  it("ignores stop_times that reference an unknown stop", () => {
    const grid = transformStopTimesToGrid(
      [{ stop_id: "GHOST", arrival_time: "08:00:00", departure_time: "08:00:00" }],
      [{ stop_id: "S1", stop_name: "Gare" }],
    );
    expect(grid.S1.times).toEqual([]);
    expect(grid.GHOST).toBeUndefined();
  });

  it("returns an empty grid for empty inputs", () => {
    expect(transformStopTimesToGrid()).toEqual({});
  });
});
