#!/usr/bin/env python3
"""
Create 5 test bookings via TyreSoft API using VRM V20ALA:
- 2 tyre bookings
- 3 service bookings

This will test the fixes for diary category and VAT pricing issues.
"""

import asyncio
import sys
from datetime import datetime, timedelta
from agent_infra import (
    get_available_slots,
    create_sale,
    save_customer,
    save_vehicle,
    lookup_vehicle_by_vrm,
    SERVICES,
    uk_date
)


async def create_tyre_booking(test_num: int, vrm: str, tyre_spec: dict):
    """Create a tyre booking"""
    print(f"\n{'='*60}")
    print(f"TEST {test_num}: TYRE BOOKING - {vrm}")
    print(f"{'='*60}")
    
    # 1. VRM Lookup
    print(f"\n[Step 1] VRM Lookup for {vrm}...")
    vrm_data = await lookup_vehicle_by_vrm(vrm)
    if not vrm_data:
        print(f"❌ VRM lookup failed for {vrm}")
        return False
    print(f"✓ Found: {vrm_data.get('make')} {vrm_data.get('model')}")
    
    # Get tyre size from VRM data
    tyre_options = vrm_data.get('tyreSizeOptions', [])
    if not tyre_options:
        print(f"❌ No tyre size options found for {vrm}")
        return False
    
    tyre_option = tyre_options[0]  # Use first/standard option
    tyre_size_front = tyre_option.get('tyreSizeFront', '')
    speed_rating_front = tyre_option.get('speedRatingFront', '')
    load_index_front = tyre_option.get('loadIndexFront', '')
    
    print(f"✓ Tyre size: {tyre_size_front} (Load: {load_index_front}, Speed: {speed_rating_front})")
    
    # 2. Get available slots for tyres (service_id = 0)
    print(f"\n[Step 2] Getting available slots for tyres...")
    tomorrow = datetime.now() + timedelta(days=1)
    slots = await get_available_slots(
        depot_id=1,
        service_ids=[0],  # Pure tyre booking
        start_date=tomorrow.strftime("%Y-%m-%d")
    )
    
    if not slots:
        print(f"❌ No slots available")
        return False
    
    selected_slot = slots[0]
    required_slot = selected_slot.get('requiredSlots', [{}])[0]
    print(f"✓ Selected slot: {selected_slot['date']} {selected_slot['time']} - Bay {required_slot.get('diaryCategoryID', 1)}")
    
    # 3. Save customer
    print(f"\n[Step 3] Saving customer...")
    customer = await save_customer(
        first_name=f"TestTyre{test_num}",
        last_name="Customer",
        mobile="07700900000",
        email=f"test.tyre{test_num}@receptionmate.ai"
    )
    if not customer:
        print(f"❌ Failed to save customer")
        return False
    print(f"✓ Customer ID: {customer.get('customerID')}")
    
    # 4. Save vehicle
    print(f"\n[Step 4] Saving vehicle...")
    vehicle = await save_vehicle(
        vrm=vrm,
        make=vrm_data.get("make", "Unknown"),
        model=vrm_data.get("model", "Unknown"),
        vehicle_info={
            "colour": vrm_data.get("colour", "Unknown")
        }
    )
    if not vehicle:
        print(f"❌ Failed to save vehicle")
        return False
    print(f"✓ Vehicle ID: {vehicle.get('vehicleID')}")
    
    # 5. Build sale items (tyres)
    print(f"\n[Step 5] Building sale items...")
    sale_items = []
    
    # Add tyres with actual size from VRM lookup - matching agent_infra structure
    for i in range(tyre_spec['quantity']):
        tyre_item = {
            "saleLineID": 0,
            "productID": 0,
            "tyrecatID": 0,
            "productEANCode": "",
            "productManufacturerCode": "",
            "serviceID": 0,  # 0 = tyre item
            "shippingService": False,
            "incomeAccountID": 0,
            "sequence": 0,
            "itemCode": tyre_spec['code'],
            "itemDescription": f"{tyre_size_front} {tyre_spec.get('brand', 'Budget')} Tyre",
            "recordedDescription": "",
            "technicianID": 0,
            "quantity": 1,
            "unitCost": tyre_spec['price'],
            "unitCostIncludesVAT": True,
            "discount": 0,
            "vatCodeID": 0,
            "backOrderQuantity": 0,
            "taggedItemIdentifier": "",
            "linkLineID": 0,
            "hideChildLinks": False,
            "groupLinkSellPrices": False,
            "voucherCode": "",
            "voucherCodeLine": False,
            "estimatedCost": 0,
            "protectEstimatedCost": False,
            "leadTime": 0,
            "sourceSupplierID": 0,
            "sourcePurchaseOrderID": 0,
            "externalOrderLineReference": "",
            "changeInQtyAffectingPickList": False,
            "creditedAmount": 0
        }
        sale_items.append(tyre_item)
        print(f"  - {tyre_item['itemDescription']} @ £{tyre_item['unitCost']}")
    
    # 6. Create sale
    print(f"\n[Step 6] Creating sale...")
    print(f"[DEBUG] Sale items to send: {sale_items}")
    
    booking_slot = {
        "date": selected_slot["date"],
        "time": selected_slot["time"],
        "diaryCategoryID": required_slot.get("diaryCategoryID", 1),
        "estimatedTime": selected_slot.get("estimatedTime", 30),
        "slotTypeID": required_slot.get("slotTypeID", 1)
    }
    
    result = await create_sale(
        depot_id=1,
        customer_id=customer["customerID"],
        vehicle_id=vehicle["vehicleID"],
        booking_slot=booking_slot,
        items=sale_items
    )
    if result:
        print(f"✅ BOOKING CREATED - Sale ID: {result.get('saleID')}")
        return True
    else:
        print(f"❌ BOOKING FAILED")
        return False


async def create_service_booking(test_num: int, vrm: str, service_code: str):
    """Create a service booking"""
    print(f"\n{'='*60}")
    print(f"TEST {test_num}: SERVICE BOOKING - {service_code}")
    print(f"{'='*60}")
    
    # Get service details
    service = SERVICES.get(service_code)
    if not service:
        print(f"❌ Unknown service: {service_code}")
        return False
    
    print(f"Service: {service['name']} (ID: {service['service_id']})")
    
    # 1. VRM Lookup
    print(f"\n[Step 1] VRM Lookup for {vrm}...")
    vrm_data = await lookup_vehicle_by_vrm(vrm)
    if not vrm_data:
        print(f"❌ VRM lookup failed for {vrm}")
        return False
    print(f"✓ Found: {vrm_data.get('make')} {vrm_data.get('model')}")
    
    # 2. Get available slots for service
    print(f"\n[Step 2] Getting available slots for {service_code}...")
    tomorrow = datetime.now() + timedelta(days=1)
    slots = await get_available_slots(
        depot_id=1,
        service_ids=[service['service_id']],  # Pure service booking
        start_date=tomorrow.strftime("%Y-%m-%d")
    )
    
    if not slots:
        print(f"❌ No slots available")
        return False
    
    selected_slot = slots[0]
    required_slot = selected_slot.get('requiredSlots', [{}])[0]
    print(f"✓ Selected slot: {selected_slot['date']} {selected_slot['time']} - Bay {required_slot.get('diaryCategoryID', 1)}")
    
    # 3. Save customer
    print(f"\n[Step 3] Saving customer...")
    customer = await save_customer(
        first_name=f"TestService{test_num}",
        last_name="Customer",
        mobile="07700900000",
        email=f"test.service{test_num}@receptionmate.ai"
    )
    if not customer:
        print(f"❌ Failed to save customer")
        return False
    print(f"✓ Customer ID: {customer.get('customerID')}")
    
    # 4. Save vehicle
    print(f"\n[Step 4] Saving vehicle...")
    vehicle = await save_vehicle(
        vrm=vrm,
        make=vrm_data.get("make", "Unknown"),
        model=vrm_data.get("model", "Unknown"),
        vehicle_info={
            "colour": vrm_data.get("colour", "Unknown")
        }
    )
    if not vehicle:
        print(f"❌ Failed to save vehicle")
        return False
    print(f"✓ Vehicle ID: {vehicle.get('vehicleID')}")
    
    # 5. Build sale items (service)
    print(f"\n[Step 5] Building sale items...")
    sale_items = [{
        "serviceID": service['service_id'],
        "itemCode": service_code,
        "itemDescription": service['name'],
        "quantity": 1,
        "unitCost": service['price'],
        "unitCostIncludesVAT": True
    }]
    print(f"  - {sale_items[0]['itemDescription']} @ £{sale_items[0]['unitCost']}")
    
    # 6. Create sale
    print(f"\n[Step 6] Creating sale...")
    print(f"[DEBUG] Sale items to send: {sale_items}")
    
    booking_slot = {
        "date": selected_slot["date"],
        "time": selected_slot["time"],
        "diaryCategoryID": required_slot.get("diaryCategoryID", 1),
        "estimatedTime": selected_slot.get("estimatedTime", 30),
        "slotTypeID": required_slot.get("slotTypeID", 1)
    }
    
    result = await create_sale(
        depot_id=1,
        customer_id=customer["customerID"],
        vehicle_id=vehicle["vehicleID"],
        booking_slot=booking_slot,
        items=sale_items
    )
    if result:
        print(f"✅ BOOKING CREATED - Sale ID: {result.get('saleID')}")
        return True
    else:
        print(f"❌ BOOKING FAILED")
        return False


async def main():
    """Run all 5 test bookings"""
    results = []
    
    print("\n" + "="*60)
    print("TYRESOFT TEST BOOKINGS - TESTING DIARY CATEGORY & VAT FIXES")
    print("Using VRM: V20ALA")
    print("="*60)
    
    # Test 1: Tyre booking (2 tyres) - Budget RADAR
    result = await create_tyre_booking(
        test_num=1,
        vrm="V20ALA",
        tyre_spec={
            'code': '2356018WRARSC0250',  # RADAR RPX-800+ - actual stock number
            'brand': 'RADAR',
            'price': 49.26,
            'quantity': 2,
            'axle': 1
        }
    )
    results.append(("Test 1: Tyre (2x Budget RADAR)", result))
    await asyncio.sleep(2)
    
    # Test 2: Tyre booking (4 tyres) - Premium PIRELLI
    result = await create_tyre_booking(
        test_num=2,
        vrm="V20ALA",
        tyre_spec={
            'code': '2356018VPI2423300',  # PIRELLI SCORPION VERDE - actual stock number
            'brand': 'PIRELLI',
            'price': 109.17,
            'quantity': 4,
            'axle': 1
        }
    )
    results.append(("Test 2: Tyre (4x Premium)", result))
    await asyncio.sleep(2)
    
    # Test 3: MOT booking
    result = await create_service_booking(
        test_num=3,
        vrm="V20ALA",
        service_code="MOT-4"
    )
    results.append(("Test 3: MOT", result))
    await asyncio.sleep(2)
    
    # Test 4: Air Con booking
    result = await create_service_booking(
        test_num=4,
        vrm="V20ALA",
        service_code="AIR1"
    )
    results.append(("Test 4: Air Con", result))
    await asyncio.sleep(2)
    
    # Test 5: Full Service booking
    result = await create_service_booking(
        test_num=5,
        vrm="V20ALA",
        service_code="FS1"
    )
    results.append(("Test 5: Full Service", result))
    
    # Summary
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    
    passed = 0
    failed = 0
    for test_name, success in results:
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} - {test_name}")
        if success:
            passed += 1
        else:
            failed += 1
    
    print(f"\nResults: {passed}/5 passed, {failed}/5 failed")
    
    if passed == 5:
        print("\n🎉 ALL TESTS PASSED!")
    elif failed == 5:
        print("\n❌ ALL TESTS FAILED - Check API credentials and connectivity")
    else:
        print(f"\n⚠️ PARTIAL SUCCESS - Review failed tests above")
    
    return passed == 5


if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
