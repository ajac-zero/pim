-- Where a setup code came from. The one a registration hands back (`registration`) is voided when the account's first passkey or sign-in is made another way, so a
-- link left on a screen or in a history cannot add a second one to an active account; one an admin issues (`admin`) is a record of its own and stays. The one the
-- operator's log gets (`operator`, from `POST /auth/setup-link`) is kept readable (`plain`) so asking again logs the same code until it expires.
ALTER TABLE pim_app.setup_codes ADD COLUMN kind text NOT NULL DEFAULT 'admin' CHECK (kind IN ('registration', 'admin', 'operator'));
ALTER TABLE pim_app.setup_codes ADD COLUMN plain text;
