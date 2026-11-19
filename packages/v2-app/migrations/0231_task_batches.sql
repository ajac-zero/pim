-- Delegation as v1 had it: one `delegate` call hands out several tasks (a batch), each to an agent in a chat of its own, and the requester hears the answers of a batch together,
-- once none of them is still working. A call that waits suspends until then (`waiter_task` is the pi task of that call, which a `task_wake` resumes). `wake_request` is the pi
-- request of the latest input given to the task's chat: when its run settles, the task is over. `said` is what the agent sent while working on it, which is its answer.
-- `delivered` is 1 once a task's answer has gone to its requester.
ALTER TABLE pim_app.tasks
	ADD COLUMN agent_id text,
	ADD COLUMN batch text,
	ADD COLUMN position integer NOT NULL DEFAULT 0,
	ADD COLUMN waits boolean NOT NULL DEFAULT false,
	ADD COLUMN waiter_task bigint,
	ADD COLUMN parent_task text,
	ADD COLUMN body text NOT NULL DEFAULT '',
	ADD COLUMN wake_request text,
	ADD COLUMN said jsonb NOT NULL DEFAULT '[]',
	ADD COLUMN delivered smallint NOT NULL DEFAULT 0;
CREATE INDEX tasks_by_batch ON pim_app.tasks (owner_id, batch);
CREATE INDEX tasks_by_chat ON pim_app.tasks (owner_id, task_chat, created_at);
