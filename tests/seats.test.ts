import { describe, expect, it } from "vitest";
import { allSeats, isValidSeat, nextSeat, seatDistance, seatsInTurnOrder } from "../src/core/seats.js";

describe("seat and turn-order helpers", () => {
  it("preserves the existing sanma seat order", () => {
    expect(allSeats(3)).toEqual([0, 1, 2]);
    expect(nextSeat(0, 3)).toBe(1);
    expect(nextSeat(1, 3)).toBe(2);
    expect(nextSeat(2, 3)).toBe(0);
  });

  it("computes sanma distance and closest-winner order from the discarder", () => {
    expect(seatDistance(0, 1, 3)).toBe(1);
    expect(seatDistance(0, 2, 3)).toBe(2);
    expect(seatsInTurnOrder(0, 3)).toEqual([1, 2]);
    expect(seatsInTurnOrder(1, 3)).toEqual([2, 0]);
    expect(seatsInTurnOrder(2, 3)).toEqual([0, 1]);
  });

  it("also computes a four-seat cycle without running a four-player game", () => {
    expect(allSeats(4)).toEqual([0, 1, 2, 3]);
    expect(nextSeat(3, 4)).toBe(0);
    expect(seatDistance(3, 2, 4)).toBe(3);
    expect(seatsInTurnOrder(2, 4)).toEqual([3, 0, 1]);
  });

  it("recognizes valid seats and rejects invalid boundaries", () => {
    expect(isValidSeat(0, 3)).toBe(true);
    expect(isValidSeat(2, 3)).toBe(true);
    expect(isValidSeat(3, 3)).toBe(false);
    expect(isValidSeat(-1, 3)).toBe(false);
  });
});
