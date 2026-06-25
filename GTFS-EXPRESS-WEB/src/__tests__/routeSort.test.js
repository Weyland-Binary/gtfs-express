import { describe, expect, it } from "vitest";
import {
  compareRoutesByPublisherOrder,
  sortRoutesByPublisherOrder,
} from "../utils/routeSort";

const ids = (routes) => routes.map((r) => r.route_id);

describe("sortRoutesByPublisherOrder", () => {
  it("honors route_sort_order first, ascending", () => {
    const sorted = sortRoutesByPublisherOrder([
      { route_id: "b", route_sort_order: 20, route_short_name: "A" },
      { route_id: "a", route_sort_order: 10, route_short_name: "Z" },
    ]);
    expect(ids(sorted)).toEqual(["a", "b"]);
  });

  it("pushes routes without route_sort_order after ordered ones", () => {
    const sorted = sortRoutesByPublisherOrder([
      { route_id: "unordered", route_short_name: "1" },
      { route_id: "ordered", route_sort_order: 99, route_short_name: "9" },
    ]);
    expect(ids(sorted)).toEqual(["ordered", "unordered"]);
  });

  it("sorts short names numerically (1, 2, 10 — not 1, 10, 2)", () => {
    const sorted = sortRoutesByPublisherOrder([
      { route_id: "r10", route_short_name: "10" },
      { route_id: "r1", route_short_name: "1" },
      { route_id: "r2", route_short_name: "2" },
    ]);
    expect(ids(sorted)).toEqual(["r1", "r2", "r10"]);
  });

  it("breaks ties deterministically on route_id", () => {
    const sorted = sortRoutesByPublisherOrder([
      { route_id: "z", route_short_name: "5" },
      { route_id: "a", route_short_name: "5" },
    ]);
    expect(ids(sorted)).toEqual(["a", "z"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      { route_id: "b", route_short_name: "2" },
      { route_id: "a", route_short_name: "1" },
    ];
    const snapshot = [...input];
    sortRoutesByPublisherOrder(input);
    expect(input).toEqual(snapshot);
  });

  it("treats empty-string route_sort_order as absent", () => {
    expect(
      compareRoutesByPublisherOrder(
        { route_id: "a", route_sort_order: "", route_short_name: "2" },
        { route_id: "b", route_sort_order: 5, route_short_name: "1" },
      ),
    ).toBeGreaterThan(0);
  });
});
