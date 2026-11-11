// The heading over the people in the Workflow tab (finding #72). New houses get no fixed team: the lead picks or
// builds one per task, so a job without a team says so above the workflow the tab shows.

/** The heading over the people, plus the note for a job with no team at all. */
export function teamHeading(jobTeam: string | null | undefined, lead: string): { title: string; note: string | null } {
  return {
    title: 'Team',
    note: jobTeam ? null : `No team is set for this job — the ${lead} picks or builds one for each task.`,
  };
}
