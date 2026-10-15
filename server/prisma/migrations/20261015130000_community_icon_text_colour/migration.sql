-- A community can choose the letters and background colour of its tile when it has no picture.
-- NULL means the default: the first two letters of its name, on the default colour.
ALTER TABLE "Community" ADD COLUMN "iconText" TEXT;
ALTER TABLE "Community" ADD COLUMN "iconColor" TEXT;
