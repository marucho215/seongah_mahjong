function assertPlayerCount(playerCount: number): void {
  if (!Number.isInteger(playerCount) || playerCount < 2) {
    throw new RangeError(`playerCount must be an integer >= 2; received ${playerCount}`);
  }
}

export function isValidSeat(seat: number, playerCount: number): boolean {
  return Number.isInteger(playerCount) && playerCount >= 2 && Number.isInteger(seat) && seat >= 0 && seat < playerCount;
}

function assertSeat(seat: number, playerCount: number): void {
  assertPlayerCount(playerCount);
  if (!isValidSeat(seat, playerCount)) {
    throw new RangeError(`seat must be an integer in [0, ${playerCount}); received ${seat}`);
  }
}

export function allSeats(playerCount: number): number[] {
  assertPlayerCount(playerCount);
  return Array.from({ length: playerCount }, (_, seat) => seat);
}

export function nextSeat(seat: number, playerCount: number): number {
  assertSeat(seat, playerCount);
  return (seat + 1) % playerCount;
}

/** Clockwise distance from `from` to `to`; 0 means the same seat. */
export function seatDistance(from: number, to: number, playerCount: number): number {
  assertSeat(from, playerCount);
  assertSeat(to, playerCount);
  return (to - from + playerCount) % playerCount;
}

/** Every other seat, nearest first, starting immediately after `from`. */
export function seatsInTurnOrder(from: number, playerCount: number): number[] {
  assertSeat(from, playerCount);
  return allSeats(playerCount)
    .filter((seat) => seat !== from)
    .sort((a, b) => seatDistance(from, a, playerCount) - seatDistance(from, b, playerCount));
}
