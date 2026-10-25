import type { PersonRef, PersonSummary } from "../shared/analysis.ts";

/** A change made in the People panel, which the opened Photo's names must follow. */
export type PeopleChange =
  | { kind: "renamed"; person: PersonRef }
  | { kind: "merged"; from: string; into: PersonRef }
  | { kind: "deleted"; personId: string }
  | { kind: "deleted-all" };

export function PeoplePanel(_: {
  people: PersonSummary[];
  onOpen: () => Promise<void>;
  onChanged: (change: PeopleChange) => void;
}) {
  return null;
}
