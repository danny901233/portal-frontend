import json
import os

output_dir = os.path.expanduser('~/Desktop/tyresoft')

# Test 1 - Budget Tyre Booking
test1 = {
    'test_number': 1,
    'description': '2x Budget Tyres (RADAR)',
    'customer': {
        'customerID': 0,
        'accountNumber': '',
        'contactData': {
            'name': {
                'salutation': '',
                'firstName': 'TestTyre1',
                'lastName': 'Customer',
                'company': ''
            },
            'address': {
                'addressLine1': '',
                'addressLine2': '',
                'addressLine3': '',
                'addressLine4': '',
                'city': '',
                'county': '',
                'postcode': '',
                'country': '',
                'longitude': '',
                'latitude': ''
            },
            'contact': {
                'contact': '',
                'mobile': '07700900000',
                'email': 'test.tyre1@receptionmate.ai',
                'telephone': '',
                'twitter': ''
            },
            'sendSMSCorrespondance': False,
            'sendEmailCorrespondance': False,
            'sendPostalCorrespondance': False,
            'marketingOptOut': False
        },
        'priceLevelID': 0,
        'creditAccount': False,
        'notes': ''
    },
    'vehicle': {
        'vehicleID': 0,
        'specifications': {
            'vrm': 'V20ALA',
            'make': 'LAND ROVER',
            'model': 'RANGE ROVER EVOQUE R-DYN S D A',
            'yearOfManufacture': '',
            'colour': 'WHITE',
            'mvrisMakeCode': '',
            'mvrisModelCode': '',
            'vinSerialNo': '',
            'dateFirstRegistered': '',
            'engineCapacity': '',
            'transmission': '',
            'fuel': '',
            'doorplan': '',
            'engineNumber': '',
            'co2Emissions': '',
            'gears': '',
            'motDue': '',
            'taxDue': '',
            'lastVRMLookupDate': '',
            'tyreSizeOptions': []
        },
        'tyreSize': {
            'tyreSizeFront': '',
            'speedRatingFront': '',
            'loadIndexFront': '',
            'tyrePressureFront': '',
            'tyreSizeRear': '',
            'speedRatingRear': '',
            'loadIndexRear': '',
            'tyrePressureRear': ''
        },
        'customerID': 0,
        'motDueDate': '',
        'taxDueDate': '',
        'serviceDueDate': '',
        'tyreCheckDate': '',
        'nextInspectionDate': '',
        'authorisedVehicle': False,
        'fleetNumber': '',
        'vrmChecked': False,
        'flagData': {
            'flagName': '',
            'flagNotes': ''
        }
    },
    'sale': {
        'depotID': 1,
        'saleDate': '2026-03-20',
        'saleStatus': 'Order',
        'notes': 'Booking created via Reception Mate Voice AI',
        'worksheetNumber': '',
        'salesAdvisorID': 0,
        'poNumber': 'RM-1773955438',
        'flag': 1,
        'flagNotes': 'Reception Mate Booking',
        'advertisingSurvey': '',
        'customerID': 1102,
        'currencyUnit': {
            'currencyCode': '',
            'conversionRate': 0
        },
        'vehicleID': 543,
        'vehicleMileage': 0,
        'channelID': 24,
        'orderStatus': 'Awaiting Acknowledgement',
        'externalOrderReference': '',
        'channelBuyer': '',
        'overrideInvoiceNumber': '',
        'deliveryAddressID': 0,
        'deliveryType': 'NONE',
        'sourceShippingOverride': '',
        'fittingCentreID': 0,
        'deliverToFittingCentre': False,
        'workSummary': '',
        'advisoryNotes': '',
        'bookingSlot': {
            'date': '2026-03-20',
            'time': '14:00',
            'diaryCategoryID': 1,
            'estimatedTime': 30,
            'slotTypeID': 1
        },
        'items': [
            {
                'saleLineID': 0,
                'productID': 0,
                'tyrecatID': 0,
                'productEANCode': '',
                'productManufacturerCode': '',
                'serviceID': 0,
                'shippingService': False,
                'incomeAccountID': 0,
                'sequence': 0,
                'itemCode': '2356018WRARSC0250',
                'itemDescription': '235/60R18 107V RADAR Tyre',
                'recordedDescription': '',
                'technicianID': 0,
                'quantity': 1,
                'unitCost': 49.26,
                'unitCostIncludesVAT': True,
                'discount': 0,
                'vatCodeID': 0,
                'backOrderQuantity': 0,
                'taggedItemIdentifier': '',
                'linkLineID': 0,
                'hideChildLinks': False,
                'groupLinkSellPrices': False,
                'voucherCode': '',
                'voucherCodeLine': False,
                'estimatedCost': 0,
                'protectEstimatedCost': False,
                'leadTime': 0,
                'sourceSupplierID': 0,
                'sourcePurchaseOrderID': 0,
                'externalOrderLineReference': '',
                'changeInQtyAffectingPickList': False,
                'creditedAmount': 0
            },
            {
                'saleLineID': 0,
                'productID': 0,
                'tyrecatID': 0,
                'productEANCode': '',
                'productManufacturerCode': '',
                'serviceID': 0,
                'shippingService': False,
                'incomeAccountID': 0,
                'sequence': 0,
                'itemCode': '2356018WRARSC0250',
                'itemDescription': '235/60R18 107V RADAR Tyre',
                'recordedDescription': '',
                'technicianID': 0,
                'quantity': 1,
                'unitCost': 49.26,
                'unitCostIncludesVAT': True,
                'discount': 0,
                'vatCodeID': 0,
                'backOrderQuantity': 0,
                'taggedItemIdentifier': '',
                'linkLineID': 0,
                'hideChildLinks': False,
                'groupLinkSellPrices': False,
                'voucherCode': '',
                'voucherCodeLine': False,
                'estimatedCost': 0,
                'protectEstimatedCost': False,
                'leadTime': 0,
                'sourceSupplierID': 0,
                'sourcePurchaseOrderID': 0,
                'externalOrderLineReference': '',
                'changeInQtyAffectingPickList': False,
                'creditedAmount': 0
            }
        ],
        'holdUntilDate': '',
        'authorisePayment': '',
        'payments': [
            {
                'paymentMethodID': 0,
                'paymentAmount': 0,
                'paymentDate': '',
                'paymentReference': '',
                'externalReference': '',
                'leaveUnallocated': True,
                'depotID': 0,
                'overrideDepositAccountID': 0,
                'customerID': 0
            }
        ],
        'customGroupID': 0,
        'customValues': [],
        'vatOverrideAmount': 0,
        'grossTotalForVATOverride': 0,
        'gsQuoteJobNumber': 0,
        'collectionSourceSaleLineID': 0
    }
}

# Test 2 - Premium Tyre Booking
test2 = {
    'test_number': 2,
    'description': '4x Premium Tyres (PIRELLI)',
    'customer': {
        'customerID': 0,
        'accountNumber': '',
        'contactData': {
            'name': {
                'salutation': '',
                'firstName': 'TestTyre2',
                'lastName': 'Customer',
                'company': ''
            },
            'address': {
                'addressLine1': '',
                'addressLine2': '',
                'addressLine3': '',
                'addressLine4': '',
                'city': '',
                'county': '',
                'postcode': '',
                'country': '',
                'longitude': '',
                'latitude': ''
            },
            'contact': {
                'contact': '',
                'mobile': '07700900000',
                'email': 'test.tyre2@receptionmate.ai',
                'telephone': '',
                'twitter': ''
            },
            'sendSMSCorrespondance': False,
            'sendEmailCorrespondance': False,
            'sendPostalCorrespondance': False,
            'marketingOptOut': False
        },
        'priceLevelID': 0,
        'creditAccount': False,
        'notes': ''
    },
    'vehicle': test1['vehicle'],
    'sale': {
        'depotID': 1,
        'saleDate': '2026-03-20',
        'saleStatus': 'Order',
        'notes': 'Booking created via Reception Mate Voice AI',
        'worksheetNumber': '',
        'salesAdvisorID': 0,
        'poNumber': 'RM-1773955443',
        'flag': 1,
        'flagNotes': 'Reception Mate Booking',
        'advertisingSurvey': '',
        'customerID': 1103,
        'currencyUnit': {
            'currencyCode': '',
            'conversionRate': 0
        },
        'vehicleID': 543,
        'vehicleMileage': 0,
        'channelID': 24,
        'orderStatus': 'Awaiting Acknowledgement',
        'externalOrderReference': '',
        'channelBuyer': '',
        'overrideInvoiceNumber': '',
        'deliveryAddressID': 0,
        'deliveryType': 'NONE',
        'sourceShippingOverride': '',
        'fittingCentreID': 0,
        'deliverToFittingCentre': False,
        'workSummary': '',
        'advisoryNotes': '',
        'bookingSlot': {
            'date': '2026-03-20',
            'time': '14:30',
            'diaryCategoryID': 1,
            'estimatedTime': 30,
            'slotTypeID': 1
        },
        'items': [
            {
                'saleLineID': 0,
                'productID': 0,
                'tyrecatID': 0,
                'productEANCode': '',
                'productManufacturerCode': '',
                'serviceID': 0,
                'shippingService': False,
                'incomeAccountID': 0,
                'sequence': 0,
                'itemCode': '2356018VPI2423300',
                'itemDescription': '235/60R18 107V PIRELLI Tyre',
                'recordedDescription': '',
                'technicianID': 0,
                'quantity': 1,
                'unitCost': 109.17,
                'unitCostIncludesVAT': True,
                'discount': 0,
                'vatCodeID': 0,
                'backOrderQuantity': 0,
                'taggedItemIdentifier': '',
                'linkLineID': 0,
                'hideChildLinks': False,
                'groupLinkSellPrices': False,
                'voucherCode': '',
                'voucherCodeLine': False,
                'estimatedCost': 0,
                'protectEstimatedCost': False,
                'leadTime': 0,
                'sourceSupplierID': 0,
                'sourcePurchaseOrderID': 0,
                'externalOrderLineReference': '',
                'changeInQtyAffectingPickList': False,
                'creditedAmount': 0
            },
            {
                'saleLineID': 0,
                'productID': 0,
                'tyrecatID': 0,
                'productEANCode': '',
                'productManufacturerCode': '',
                'serviceID': 0,
                'shippingService': False,
                'incomeAccountID': 0,
                'sequence': 0,
                'itemCode': '2356018VPI2423300',
                'itemDescription': '235/60R18 107V PIRELLI Tyre',
                'recordedDescription': '',
                'technicianID': 0,
                'quantity': 1,
                'unitCost': 109.17,
                'unitCostIncludesVAT': True,
                'discount': 0,
                'vatCodeID': 0,
                'backOrderQuantity': 0,
                'taggedItemIdentifier': '',
                'linkLineID': 0,
                'hideChildLinks': False,
                'groupLinkSellPrices': False,
                'voucherCode': '',
                'voucherCodeLine': False,
                'estimatedCost': 0,
                'protectEstimatedCost': False,
                'leadTime': 0,
                'sourceSupplierID': 0,
                'sourcePurchaseOrderID': 0,
                'externalOrderLineReference': '',
                'changeInQtyAffectingPickList': False,
                'creditedAmount': 0
            },
            {
                'saleLineID': 0,
                'productID': 0,
                'tyrecatID': 0,
                'productEANCode': '',
                'productManufacturerCode': '',
                'serviceID': 0,
                'shippingService': False,
                'incomeAccountID': 0,
                'sequence': 0,
                'itemCode': '2356018VPI2423300',
                'itemDescription': '235/60R18 107V PIRELLI Tyre',
                'recordedDescription': '',
                'technicianID': 0,
                'quantity': 1,
                'unitCost': 109.17,
                'unitCostIncludesVAT': True,
                'discount': 0,
                'vatCodeID': 0,
                'backOrderQuantity': 0,
                'taggedItemIdentifier': '',
                'linkLineID': 0,
                'hideChildLinks': False,
                'groupLinkSellPrices': False,
                'voucherCode': '',
                'voucherCodeLine': False,
                'estimatedCost': 0,
                'protectEstimatedCost': False,
                'leadTime': 0,
                'sourceSupplierID': 0,
                'sourcePurchaseOrderID': 0,
                'externalOrderLineReference': '',
                'changeInQtyAffectingPickList': False,
                'creditedAmount': 0
            },
            {
                'saleLineID': 0,
                'productID': 0,
                'tyrecatID': 0,
                'productEANCode': '',
                'productManufacturerCode': '',
                'serviceID': 0,
                'shippingService': False,
                'incomeAccountID': 0,
                'sequence': 0,
                'itemCode': '2356018VPI2423300',
                'itemDescription': '235/60R18 107V PIRELLI Tyre',
                'recordedDescription': '',
                'technicianID': 0,
                'quantity': 1,
                'unitCost': 109.17,
                'unitCostIncludesVAT': True,
                'discount': 0,
                'vatCodeID': 0,
                'backOrderQuantity': 0,
                'taggedItemIdentifier': '',
                'linkLineID': 0,
                'hideChildLinks': False,
                'groupLinkSellPrices': False,
                'voucherCode': '',
                'voucherCodeLine': False,
                'estimatedCost': 0,
                'protectEstimatedCost': False,
                'leadTime': 0,
                'sourceSupplierID': 0,
                'sourcePurchaseOrderID': 0,
                'externalOrderLineReference': '',
                'changeInQtyAffectingPickList': False,
                'creditedAmount': 0
            }
        ],
        'holdUntilDate': '',
        'authorisePayment': '',
        'payments': [
            {
                'paymentMethodID': 0,
                'paymentAmount': 0,
                'paymentDate': '',
                'paymentReference': '',
                'externalReference': '',
                'leaveUnallocated': True,
                'depotID': 0,
                'overrideDepositAccountID': 0,
                'customerID': 0
            }
        ],
        'customGroupID': 0,
        'customValues': [],
        'vatOverrideAmount': 0,
        'grossTotalForVATOverride': 0,
        'gsQuoteJobNumber': 0,
        'collectionSourceSaleLineID': 0
    }
}

# Test 3 - MOT Booking
test3 = {
    'test_number': 3,
    'description': 'MOT Class 4 Online',
    'customer': {
        'customerID': 0,
        'accountNumber': '',
        'contactData': {
            'name': {
                'salutation': '',
                'firstName': 'TestService3',
                'lastName': 'Customer',
                'company': ''
            },
            'address': {
                'addressLine1': '',
                'addressLine2': '',
                'addressLine3': '',
                'addressLine4': '',
                'city': '',
                'county': '',
                'postcode': '',
                'country': '',
                'longitude': '',
                'latitude': ''
            },
            'contact': {
                'contact': '',
                'mobile': '07700900000',
                'email': 'test.service3@receptionmate.ai',
                'telephone': '',
                'twitter': ''
            },
            'sendSMSCorrespondance': False,
            'sendEmailCorrespondance': False,
            'sendPostalCorrespondance': False,
            'marketingOptOut': False
        },
        'priceLevelID': 0,
        'creditAccount': False,
        'notes': ''
    },
    'vehicle': test1['vehicle'],
    'sale': {
        'depotID': 1,
        'saleDate': '2026-03-23',
        'saleStatus': 'Order',
        'notes': 'Booking created via Reception Mate Voice AI',
        'worksheetNumber': '',
        'salesAdvisorID': 0,
        'poNumber': 'RM-1773955447',
        'flag': 1,
        'flagNotes': 'Reception Mate Booking',
        'advertisingSurvey': '',
        'customerID': 1104,
        'currencyUnit': {
            'currencyCode': '',
            'conversionRate': 0
        },
        'vehicleID': 543,
        'vehicleMileage': 0,
        'channelID': 24,
        'orderStatus': 'Awaiting Acknowledgement',
        'externalOrderReference': '',
        'channelBuyer': '',
        'overrideInvoiceNumber': '',
        'deliveryAddressID': 0,
        'deliveryType': 'NONE',
        'sourceShippingOverride': '',
        'fittingCentreID': 0,
        'deliverToFittingCentre': False,
        'workSummary': '',
        'advisoryNotes': '',
        'bookingSlot': {
            'date': '2026-03-23',
            'time': '13:30',
            'diaryCategoryID': 3,
            'estimatedTime': 60,
            'slotTypeID': 6
        },
        'items': [
            {
                'serviceID': 58,
                'itemCode': 'MOT-4',
                'itemDescription': 'MOT Class 4 Online',
                'quantity': 1,
                'unitCost': 50.0,
                'unitCostIncludesVAT': True
            }
        ],
        'holdUntilDate': '',
        'authorisePayment': '',
        'payments': [
            {
                'paymentMethodID': 0,
                'paymentAmount': 0,
                'paymentDate': '',
                'paymentReference': '',
                'externalReference': '',
                'leaveUnallocated': True,
                'depotID': 0,
                'overrideDepositAccountID': 0,
                'customerID': 0
            }
        ],
        'customGroupID': 0,
        'customValues': [],
        'vatOverrideAmount': 0,
        'grossTotalForVATOverride': 0,
        'gsQuoteJobNumber': 0,
        'collectionSourceSaleLineID': 0
    }
}

# Test 4 - Air Con Booking
test4 = {
    'test_number': 4,
    'description': 'Air Con Recharge - R134a',
    'customer': {
        'customerID': 0,
        'accountNumber': '',
        'contactData': {
            'name': {
                'salutation': '',
                'firstName': 'TestService4',
                'lastName': 'Customer',
                'company': ''
            },
            'address': {
                'addressLine1': '',
                'addressLine2': '',
                'addressLine3': '',
                'addressLine4': '',
                'city': '',
                'county': '',
                'postcode': '',
                'country': '',
                'longitude': '',
                'latitude': ''
            },
            'contact': {
                'contact': '',
                'mobile': '07700900000',
                'email': 'test.service4@receptionmate.ai',
                'telephone': '',
                'twitter': ''
            },
            'sendSMSCorrespondance': False,
            'sendEmailCorrespondance': False,
            'sendPostalCorrespondance': False,
            'marketingOptOut': False
        },
        'priceLevelID': 0,
        'creditAccount': False,
        'notes': ''
    },
    'vehicle': test1['vehicle'],
    'sale': {
        'depotID': 1,
        'saleDate': '2026-03-20',
        'saleStatus': 'Order',
        'notes': 'Booking created via Reception Mate Voice AI',
        'worksheetNumber': '',
        'salesAdvisorID': 0,
        'poNumber': 'RM-1773955451',
        'flag': 1,
        'flagNotes': 'Reception Mate Booking',
        'advertisingSurvey': '',
        'customerID': 1105,
        'currencyUnit': {
            'currencyCode': '',
            'conversionRate': 0
        },
        'vehicleID': 543,
        'vehicleMileage': 0,
        'channelID': 24,
        'orderStatus': 'Awaiting Acknowledgement',
        'externalOrderReference': '',
        'channelBuyer': '',
        'overrideInvoiceNumber': '',
        'deliveryAddressID': 0,
        'deliveryType': 'NONE',
        'sourceShippingOverride': '',
        'fittingCentreID': 0,
        'deliverToFittingCentre': False,
        'workSummary': '',
        'advisoryNotes': '',
        'bookingSlot': {
            'date': '2026-03-20',
            'time': '11:30',
            'diaryCategoryID': 8,
            'estimatedTime': 30,
            'slotTypeID': 10
        },
        'items': [
            {
                'serviceID': 11,
                'itemCode': 'AIR1',
                'itemDescription': 'Air Con Recharge - R134a',
                'quantity': 1,
                'unitCost': 84.0,
                'unitCostIncludesVAT': True
            }
        ],
        'holdUntilDate': '',
        'authorisePayment': '',
        'payments': [
            {
                'paymentMethodID': 0,
                'paymentAmount': 0,
                'paymentDate': '',
                'paymentReference': '',
                'externalReference': '',
                'leaveUnallocated': True,
                'depotID': 0,
                'overrideDepositAccountID': 0,
                'customerID': 0
            }
        ],
        'customGroupID': 0,
        'customValues': [],
        'vatOverrideAmount': 0,
        'grossTotalForVATOverride': 0,
        'gsQuoteJobNumber': 0,
        'collectionSourceSaleLineID': 0
    }
}

# Test 5 - Full Service Booking
test5 = {
    'test_number': 5,
    'description': 'Full Service 0cc-1199cc',
    'customer': {
        'customerID': 0,
        'accountNumber': '',
        'contactData': {
            'name': {
                'salutation': '',
                'firstName': 'TestService5',
                'lastName': 'Customer',
                'company': ''
            },
            'address': {
                'addressLine1': '',
                'addressLine2': '',
                'addressLine3': '',
                'addressLine4': '',
                'city': '',
                'county': '',
                'postcode': '',
                'country': '',
                'longitude': '',
                'latitude': ''
            },
            'contact': {
                'contact': '',
                'mobile': '07700900000',
                'email': 'test.service5@receptionmate.ai',
                'telephone': '',
                'twitter': ''
            },
            'sendSMSCorrespondance': False,
            'sendEmailCorrespondance': False,
            'sendPostalCorrespondance': False,
            'marketingOptOut': False
        },
        'priceLevelID': 0,
        'creditAccount': False,
        'notes': ''
    },
    'vehicle': test1['vehicle'],
    'sale': {
        'depotID': 1,
        'saleDate': '2026-03-21',
        'saleStatus': 'Order',
        'notes': 'Booking created via Reception Mate Voice AI',
        'worksheetNumber': '',
        'salesAdvisorID': 0,
        'poNumber': 'RM-1773955455',
        'flag': 1,
        'flagNotes': 'Reception Mate Booking',
        'advertisingSurvey': '',
        'customerID': 1106,
        'currencyUnit': {
            'currencyCode': '',
            'conversionRate': 0
        },
        'vehicleID': 543,
        'vehicleMileage': 0,
        'channelID': 24,
        'orderStatus': 'Awaiting Acknowledgement',
        'externalOrderReference': '',
        'channelBuyer': '',
        'overrideInvoiceNumber': '',
        'deliveryAddressID': 0,
        'deliveryType': 'NONE',
        'sourceShippingOverride': '',
        'fittingCentreID': 0,
        'deliverToFittingCentre': False,
        'workSummary': '',
        'advisoryNotes': '',
        'bookingSlot': {
            'date': '2026-03-21',
            'time': '10:00',
            'diaryCategoryID': 2,
            'estimatedTime': 90,
            'slotTypeID': 7
        },
        'items': [
            {
                'serviceID': 2,
                'itemCode': 'FS1',
                'itemDescription': 'Full Service 0cc-1199cc',
                'quantity': 1,
                'unitCost': 132.0,
                'unitCostIncludesVAT': True
            }
        ],
        'holdUntilDate': '',
        'authorisePayment': '',
        'payments': [
            {
                'paymentMethodID': 0,
                'paymentAmount': 0,
                'paymentDate': '',
                'paymentReference': '',
                'externalReference': '',
                'leaveUnallocated': True,
                'depotID': 0,
                'overrideDepositAccountID': 0,
                'customerID': 0
            }
        ],
        'customGroupID': 0,
        'customValues': [],
        'vatOverrideAmount': 0,
        'grossTotalForVATOverride': 0,
        'gsQuoteJobNumber': 0,
        'collectionSourceSaleLineID': 0
    }
}

# Write all JSON files
tests = [
    ('test1_budget_tyres.json', test1),
    ('test2_premium_tyres.json', test2),
    ('test3_mot.json', test3),
    ('test4_air_con.json', test4),
    ('test5_full_service.json', test5)
]

for filename, data in tests:
    filepath = os.path.join(output_dir, filename)
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=2)
    print(f'✅ Created {filename}')

print(f'\n✅ All JSON files saved to {output_dir}')
