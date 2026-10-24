-- CreateTable
CREATE TABLE "TyresoftCustomer" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "customerAccountNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "salutation" TEXT,
    "contact" TEXT,
    "telephone" TEXT NOT NULL DEFAULT '',
    "mobile" TEXT NOT NULL DEFAULT '',
    "email" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TyresoftCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TyresoftVehicle" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "vrm" TEXT NOT NULL,
    "customerAccountNumber" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "motDueDate" TIMESTAMP(3),
    "tyreCheckDate" TIMESTAMP(3),
    "serviceDueDate" TIMESTAMP(3),
    "nextInspectionDate" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TyresoftVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TyresoftCustomer_garageId_mobile_idx" ON "TyresoftCustomer"("garageId", "mobile");

-- CreateIndex
CREATE INDEX "TyresoftCustomer_garageId_telephone_idx" ON "TyresoftCustomer"("garageId", "telephone");

-- CreateIndex
CREATE UNIQUE INDEX "TyresoftCustomer_garageId_customerAccountNumber_key" ON "TyresoftCustomer"("garageId", "customerAccountNumber");

-- CreateIndex
CREATE INDEX "TyresoftVehicle_garageId_customerAccountNumber_idx" ON "TyresoftVehicle"("garageId", "customerAccountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TyresoftVehicle_garageId_vrm_key" ON "TyresoftVehicle"("garageId", "vrm");

