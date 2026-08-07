-- Renames User.courseOfStudy to User.workplaceRole.
--
-- Written by hand ON PURPOSE. `prisma migrate dev` renders a field rename as
-- DROP COLUMN + ADD COLUMN, which would discard every existing user's stored
-- value. RENAME COLUMN preserves the data and is a metadata-only operation in
-- Postgres, so it does not rewrite the table or take a long lock.

-- AlterTable
ALTER TABLE "User" RENAME COLUMN "courseOfStudy" TO "workplaceRole";
