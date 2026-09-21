-- CreateTable: Add role field to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'NGO';

-- Extend Restaurant model
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "fssaiNumber" TEXT;

-- Extend NGO model  
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "tagline" TEXT;
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "darpanId" TEXT;
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "taxExemption" TEXT;
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "operatingBase" TEXT DEFAULT 'Main Logistics Depot';
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "defaultRadiusKm" DOUBLE PRECISION NOT NULL DEFAULT 8.0;
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "pickupMode" TEXT NOT NULL DEFAULT 'NGO Representative Self-Pickup';
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "isVerified" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "totalMealsRescued" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "foodWastePreventedKg" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "co2eAvoidedTonnes" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "NGO" ADD COLUMN IF NOT EXISTS "activePartners" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: Listing
CREATE TABLE IF NOT EXISTS "Listing" (
    "id" SERIAL PRIMARY KEY,
    "foodName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "totalServings" INTEGER NOT NULL,
    "availableServings" INTEGER NOT NULL,
    "preparedTime" TEXT NOT NULL,
    "safeUntil" TIMESTAMP(3) NOT NULL,
    "remainingHoursText" TEXT,
    "isUrgent" BOOLEAN NOT NULL DEFAULT false,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "dietary" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "storageInstructions" TEXT,
    "imageUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "restaurantId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Listing_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable: Reservation
CREATE TABLE IF NOT EXISTS "Reservation" (
    "id" SERIAL PRIMARY KEY,
    "code" TEXT NOT NULL UNIQUE,
    "reservedServings" INTEGER NOT NULL,
    "pickupDeadline" TIMESTAMP(3) NOT NULL,
    "pickupCode" TEXT NOT NULL,
    "pickupInstructions" TEXT,
    "shelterDelivered" TEXT,
    "fssaiVerified" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ready_for_pickup',
    "completedAt" TIMESTAMP(3),
    "listingId" INTEGER NOT NULL,
    "ngoId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Reservation_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Reservation_ngoId_fkey" FOREIGN KEY ("ngoId") REFERENCES "NGO"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Enable earthdistance extension for PostGIS proximity queries
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

-- Index: Listing status for fast active feed queries
CREATE INDEX IF NOT EXISTS "Listing_status_idx" ON "Listing"("status");
CREATE INDEX IF NOT EXISTS "Listing_restaurantId_idx" ON "Listing"("restaurantId");

-- Index: Reservation by NGO and status for active pickup view
CREATE INDEX IF NOT EXISTS "Reservation_ngoId_status_idx" ON "Reservation"("ngoId", "status");

-- Index: Geospatial lookups
CREATE INDEX IF NOT EXISTS "Restaurant_geo_idx" ON "Restaurant"("latitude", "longitude");
CREATE INDEX IF NOT EXISTS "NGO_geo_idx" ON "NGO"("latitude", "longitude");
