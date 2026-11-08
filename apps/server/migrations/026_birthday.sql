-- Birthday. One nullable text column on person holding YYYY-MM-DD, or MM-DD when the year is unknown or unshared. The
-- write path validates the spelling; existing rows start empty.
ALTER TABLE person ADD COLUMN birthday TEXT;
