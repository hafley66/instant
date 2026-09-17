// The marks a square carries: the tags the frame brought with it, and whether
// its turn is a favorite.
//
// Both lookups are local. The tags ride the push (the server read them in the
// same statement that read the turns), and the favorites are the cache
// `favorites.ts` keeps warm on enable and on every toggle — so a popover never
// waits on a read, which is the whole point of rendering it with the square.
import { boopFavorites } from "./favorites"
import type { Strip } from "./1_agentSquaresFeed"

export type TurnMark = {
  favorite: boolean
  tags: string[]
}

/** One mark per turn the frame carries, keyed by turn id. */
export function marksOf(frame: Strip): Map<string, TurnMark> {
  const favorites = new Set(boopFavorites.map((favorite) => favorite.source))
  const marks = new Map<string, TurnMark>()
  for (const turn of frame.turns) {
    const source = `turn:${turn.session}:${turn.turn}`
    marks.set(turn.id, {
      favorite: favorites.has(source),
      tags: frame.tags[source] ?? [],
    })
  }
  return marks
}
