import { toRepoRelative } from "./git.ts";
import type { Summary, SummaryItem } from "./summarize.ts";
import type { Transcript } from "./transcript.ts";
import type { RecordItem } from "./types.ts";

const STOPWORDS = new Set(
  (
    "about above after again agent also because been before being both changed could does doing done during each " +
    "from have having here instead into just made make makes more most much must need only other over same session " +
    "should since some still such than that their them then there these they this those through used user uses using " +
    "very want were what when where which while will with without would your"
  ).split(" "),
);

function keyTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? [])].filter((term) => !STOPWORDS.has(term));
}

export interface VerifiedItems {
  decisions: RecordItem[];
  deadEnds: RecordItem[];
  openQuestions: RecordItem[];
  /** Items dropped because no cited turn exists or mentions them. */
  dropped: number;
}

/**
 * Keeps items whose cited turns exist and share at least one key term with the item, and limits item
 * paths to files the session changed. This catches fabricated citations, not misread ones.
 */
export function verifySummary(summary: Summary, transcript: Transcript, root: string, paths: string[]): VerifiedItems {
  const sessionPaths = new Set(paths);
  let dropped = 0;
  const verify = (items: SummaryItem[]): RecordItem[] =>
    items.flatMap((item) => {
      const cited = item.turns.map((turn) => transcript.turns[turn - 1]).filter((turn) => turn !== undefined);
      const evidence = cited.map((turn) => turn.text.toLowerCase()).join("\n");
      const terms = keyTerms(item.text);
      if (cited.length === 0 || (terms.length > 0 && !terms.some((term) => evidence.includes(term)))) {
        dropped += 1;
        return [];
      }
      const itemPaths = item.paths
        .map((path) => toRepoRelative(root, path))
        .filter((path): path is string => path !== null && sessionPaths.has(path));
      return [{ text: item.text, paths: [...new Set(itemPaths)] }];
    });
  const decisions = verify(summary.decisions);
  const deadEnds = verify(summary.deadEnds);
  const openQuestions = verify(summary.openQuestions);
  return { decisions, deadEnds, openQuestions, dropped };
}
