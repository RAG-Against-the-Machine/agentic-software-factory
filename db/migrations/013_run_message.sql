-- Planner chat. The plan stage is a conversation, not an approve/reject form.
-- Each row is one turn: the planner's reply (its questions or its plan summary)
-- or a person's message back. A person's message re-runs the planner, which
-- resumes its own agent session when the runtime can (session_id) and otherwise
-- re-reads this whole thread in a fresh prompt.
--
-- author is agent or human. role is the role that spoke or was spoken to.
-- kind is question, plan or reply for an agent turn and message for a human one.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
CREATE TABLE IF NOT EXISTS run_message (
  id          text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES agent_run(id),
  task_id     text REFERENCES run_task(id),
  role        text NOT NULL,
  author      text NOT NULL,
  kind        text NOT NULL,
  body        text NOT NULL,
  by_user     text,
  session_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_message_run ON run_message (run_id, created_at);
