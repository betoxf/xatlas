/**
 * The prompt for the one planner of a job whose way is clear: no discussion. The planner may
 * read the project and changes nothing. It carries the same two sentences on the request as
 * the parliament's prompts (`ANCHOR_RULES` in the swarm), and the same "beyond the request"
 * section.
 */
export function planPrompt(input: {
  readonly task: string;
  /** What triage understood the person to want. */
  readonly understood?: string;
  /** What the person added on the board before the job started, oldest first. */
  readonly notes?: readonly string[];
}): string {
  return [
    "Write the plan for the job below. You may read the project to ground it, but don't change any files, run builds or make commits: this is planning only.",
    "",
    "Job:",
    input.task,
    ...(input.understood ? ["", `Understood as: ${input.understood}`] : []),
    ...(input.notes && input.notes.length > 0
      ? ["", "The person added:", ...input.notes.map((note) => `- ${note}`)]
      : []),
    "",
    "Improve HOW it is built; do not change WHAT was asked. An idea that goes beyond or against the request is written apart, for the person to decide, never into the approach or the steps.",
    "",
    "Give the approach and why, the steps with the files or components each one touches, the main risks, and how to verify it worked. The steps will be given to several agents working side by side, so say which steps can run at the same time and which must wait for another. Every step ends as its own reviewed branch: do not plan a step that merges or joins the branches, because that happens later, outside this job. End with a section headed ## Beyond the request (not steps: ideas for the person to decide), or leave it out when you have none. At most 500 words. Reply with the plan only.",
  ].join("\n");
}
