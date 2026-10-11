import type { ThemeManifest } from '../theme.js';

/**
 * The default theme. The crew is the "Team", members are named after the stage
 * they run, and the quips say plainly what the stage is doing. The colours are
 * Dracula's (VS Code): background, text and the purple accent.
 */
export const CLASSIC_THEME: ThemeManifest = {
  id: 'classic',
  name: 'Classic',
  description: 'The plain factory look: a team of four with a coordinator.',
  appTitle: 'Agentic Software Factory',
  accent: '#bd93f9',
  background: '#282a36',
  text: '#f8f8f2',
  crew: { name: 'Team' },
  members: {
    orchestrator: { name: 'Coordinator' },
    planner: { name: 'Planner' },
    implementer: { name: 'Implementer' },
    tester: { name: 'Tester' },
    reviewer: { name: 'Reviewer' },
  },
  quips: {
    planner: [
      'Reading the ticket',
      'Exploring the repository',
      'Finding the files that need to change',
      'Checking the plan against the ticket',
      'Writing the plan',
    ],
    implementer: [
      'Reading the plan',
      'Reading the surrounding code',
      'Editing files',
      'Running the build',
      'Committing the change',
    ],
    tester: [
      'Reading the change',
      'Running the tests',
      'Checking the edge cases',
      'Writing up the results',
    ],
    reviewer: [
      'Reading the diff',
      'Comparing the change with the plan',
      'Checking for unrelated changes',
      'Deciding: approve or request changes',
    ],
    orchestrator: [
      'Starting the next step',
      'Checking on the job',
      'Recording progress',
    ],
  },
  moods: {
    handoff: ['Handing over to the {member}'],
    working: ['The {member} is working'],
    gate: ['Waiting for your decision'],
    question: ['The {member} has a question for you'],
    conflict: ['Sorting out a merge conflict'],
    delivering: ['Opening the change request'],
    delivered: ['Done. The work is delivered'],
    failed: ['This job stopped'],
    idle: ['Waiting to start'],
  },
};
