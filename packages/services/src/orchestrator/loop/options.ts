/**
 * The options decisions offer, by id: the one place each id is spelled. Code that compares an
 * answer with an option goes through `option`, so a misspelt id fails to compile.
 */
export const OPTION_LABELS = {
  start: "Start the job",
  retry: "Try again",
  resume: "Let it carry on",
  answered: "I answered it in the conversation",
  reassign: "Give the step to a new executor",
  fix: "Send the findings back once more",
  drop: "Pass the step as it is",
  keep: "The finding stands",
  "drop-finding": "Drop the finding",
  send: "Send it to the executors",
  accept: "Accept the work as it is",
  findings: "Send the findings anyway",
  "stop-step": "Stop this step",
  "stop-job": "Stop the job",
} as const;

export type OptionId = keyof typeof OPTION_LABELS;

/** An option id, checked against the list above. */
export function option<T extends OptionId>(id: T): T {
  return id;
}
