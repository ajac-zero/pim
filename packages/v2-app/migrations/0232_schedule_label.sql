-- A scheduled task's name, shown to the person and used as the title of each chat it starts, and in the message it wakes its agent with: `[Scheduled task "label" id] instruction`.
ALTER TABLE pim_app.schedules ADD COLUMN label text;
