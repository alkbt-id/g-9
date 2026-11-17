/** The count of a finished game by Japanese rules, with KataGo deciding territory and dead stones. */

const ownedFrom = 0.5;

/**
 * `ownership` runs from -1 (white) to 1 (black) per point. A point a side owns is its territory; an
 * enemy stone on it is dead and also goes to the side's prisoners. Komi goes to white.
 * `owners` keeps the owner of every counted point (0 for none) for the final board.
 */
export function countGame(ownership, position, komi) {
  const sides = {
    1: { territory: 0, prisoners: position.captured[1], komi: 0 },
    2: { territory: 0, prisoners: position.captured[2], komi },
  };
  const owners = position.board.map(() => 0);
  ownership.forEach((value, point) => {
    if (Math.abs(value) < ownedFrom) return;
    const owner = value > 0 ? 1 : 2;
    const stone = position.board[point];
    if (stone === owner) return;
    owners[point] = owner;
    sides[owner].territory += 1;
    if (stone) sides[owner].prisoners += 1;
  });
  for (const side of Object.values(sides)) side.total = side.territory + side.prisoners + side.komi;
  const margin = sides[1].total - sides[2].total;
  return { sides, owners, winner: margin > 0 ? 1 : 2, margin: Math.abs(margin) };
}
