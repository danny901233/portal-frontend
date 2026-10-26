-- Postcode on the shortlist row, so the Google listing can be resolved on first click rather than
-- bought for every prospect at seed time (~94% of whom never click).
ALTER TABLE "DemoProspect" ADD COLUMN "postcode" TEXT;
