-- What an agent is for, as v1 kept it: a role (such as Researcher; the name when it has none) and a one-line description. The roster in the majordomo's prompt, `delegate`'s
-- choice of agent and `create_agent`'s test for an agent that exists already go by them. An agent migrated from v1 keeps them under config.legacy, which the application reads
-- when its own columns are empty.
ALTER TABLE pim_app.agents ADD COLUMN role text, ADD COLUMN description text NOT NULL DEFAULT '';
