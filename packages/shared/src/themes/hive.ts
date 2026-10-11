import type { ThemeManifest } from '../theme.js';

/**
 * The Hive: the agents are bees and the orchestrator is the Queen, who hands the
 * work from bee to bee and steps forward at check-ins, conflicts and delivery.
 */
export const HIVE_THEME: ThemeManifest = {
  id: 'hive',
  name: 'The Hive',
  description: 'A crew of worker bees led by the Queen.',
  crew: { name: 'The Hive' },
  members: {
    orchestrator: { name: 'The Queen' },
    planner: { name: 'Scout' },
    implementer: { name: 'Builder' },
    tester: { name: 'Guard' },
    reviewer: { name: 'Inspector' },
  },
  quips: {
    orchestrator: [
      'Keeping the hive humming',
      'Counting the cells',
      'Watching over the comb',
      'Deciding who flies next',
    ],
    planner: [
      'Flying ahead to scout the code',
      'Waggle-dancing the plan to the others',
      'Mapping every flower in the field',
      'Sniffing out where the change belongs',
      'Marking the route back to the hive',
      'Deciding which flowers to skip',
    ],
    implementer: [
      'Building comb, one cell at a time',
      'Turning nectar into honey',
      'Following the Scout\'s dance to the letter',
      'Buzzing away at the keyboard',
      'Sealing the cells with a sensible commit',
      'Wiring the comb together',
      'Arguing with the type checker (bees always win)',
    ],
    tester: [
      'Standing guard at the entrance',
      'Checking every visitor\'s scent',
      'Poking the comb for weak cells',
      'Trying to sneak in a wasp on purpose',
      'Testing the honey, fingers crossed',
      'Writing down what actually happened',
    ],
    reviewer: [
      'Inspecting every cell of the comb',
      'Holding the honey up to the light',
      'Comparing the comb with the Scout\'s map',
      'Looking for the wasp nobody noticed',
      'Checking no stray pollen snuck in',
      'Deciding: seal it or send it back',
    ],
  },
  moods: {
    handoff: ['{orchestrator} sends {member} out', '{orchestrator} hands the work to {member}'],
    working: ['{member} is buzzing away'],
    gate: ['{orchestrator} awaits your word', '{orchestrator} holds the hive for your decision'],
    question: ['{member} flew back with a question for you'],
    conflict: ['{orchestrator} is untangling the comb'],
    delivering: ['{orchestrator} carries the honey out'],
    delivered: ['The honey is in! {crew} delivered'],
    failed: ['{orchestrator} has called the hive home'],
    idle: ['{crew} is resting until the next flight'],
  },
  accent: '#e0a526',
  appTitle: 'The Hive Mind',
  background: '#1a140c',
  text: '#f3e9d2',
  handoffGlyph: '🍯',
  decor: 'honeycomb',
};
