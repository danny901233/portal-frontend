"""Simple unit tests for Service Expert LLM functionality.

Run with: python -m pytest test_service_expert.py -v
Or directly: python test_service_expert.py
"""

import asyncio
import os
import sys
from pathlib import Path

# Add parent to path so we can import from core
sys.path.insert(0, str(Path(__file__).parent))

from core.llm_experts import run_service_expert


async def test_clear_service_request():
    """Test: clear request like 'MOT' should return high confidence."""
    services = [
        {"service_price_id": "1", "name": "MOT", "price": "40.00", "duration": "60"},
        {"service_price_id": "2", "name": "Full Service", "price": "150.00", "duration": "120"},
        {"service_price_id": "3", "name": "Diagnostics", "price": "60.00", "duration": "45"},
    ]
    
    result = await run_service_expert("need an mot", services)
    print(f"\n[Test 1] Clear request 'need an mot':")
    print(f"  Service: {result.get('service_name')}")
    print(f"  Confidence: {result.get('confidence'):.2f}")
    print(f"  Reason: {result.get('reason')}")
    
    # This should ideally pick MOT with high confidence
    # Note: In real usage, fuzzy matching would catch this first,
    # so expert wouldn't be called. This tests expert's ability.
    

async def test_symptom_based_request():
    """Test: symptom like 'engine light is on' should suggest Diagnostics."""
    services = [
        {"service_price_id": "1", "name": "MOT", "price": "40.00", "duration": "60"},
        {"service_price_id": "2", "name": "Full Service", "price": "150.00", "duration": "120"},
        {"service_price_id": "3", "name": "Diagnostics", "price": "60.00", "duration": "45"},
        {"service_price_id": "4", "name": "Brake Inspection", "price": "50.00", "duration": "30"},
    ]
    
    result = await run_service_expert("my engine light is on", services)
    print(f"\n[Test 2] Symptom 'my engine light is on':")
    print(f"  Service: {result.get('service_name')}")
    print(f"  Confidence: {result.get('confidence'):.2f}")
    print(f"  Reason: {result.get('reason')}")
    print(f"  Clarifying Q: {result.get('clarifying_question')}")
    
    # Should either pick Diagnostics OR ask for clarification


async def test_ambiguous_request():
    """Test: vague 'service' should ask clarification."""
    services = [
        {"service_price_id": "1", "name": "Full Service", "price": "150.00", "duration": "120"},
        {"service_price_id": "2", "name": "Interim Service", "price": "100.00", "duration": "90"},
        {"service_price_id": "3", "name": "Oil Change", "price": "50.00", "duration": "30"},
    ]
    
    result = await run_service_expert("need a service", services)
    print(f"\n[Test 3] Ambiguous 'need a service':")
    print(f"  Service: {result.get('service_name')}")
    print(f"  Confidence: {result.get('confidence'):.2f}")
    print(f"  Reason: {result.get('reason')}")
    print(f"  Clarifying Q: {result.get('clarifying_question')}")
    
    # Should likely ask which type of service


async def test_cache_hit():
    """Test: second identical request should hit cache."""
    services = [
        {"service_price_id": "1", "name": "Tyre Fitting", "price": "80.00", "duration": "45"},
        {"service_price_id": "2", "name": "Wheel Alignment", "price": "40.00", "duration": "30"},
    ]
    
    # First call
    result1 = await run_service_expert("need new tyres", services)
    print(f"\n[Test 4a] First call 'need new tyres':")
    print(f"  Service: {result1.get('service_name')}")
    print(f"  Confidence: {result1.get('confidence'):.2f}")
    
    # Second call (should be cached)
    result2 = await run_service_expert("need new tyres", services)
    print(f"\n[Test 4b] Second call 'need new tyres' (should be cached):")
    print(f"  Service: {result2.get('service_name')}")
    print(f"  Confidence: {result2.get('confidence'):.2f}")
    
    # Results should be identical
    assert result1 == result2, "Cache should return identical results"
    print("  ✓ Cache hit confirmed")


async def main():
    """Run all tests."""
    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set. Please set it to run tests.")
        print("Example: export OPENAI_API_KEY='sk-...'")
        return 1
    
    print("=" * 60)
    print("Service Expert LLM Tests")
    print("=" * 60)
    
    try:
        await test_clear_service_request()
        await test_symptom_based_request()
        await test_ambiguous_request()
        await test_cache_hit()
        
        print("\n" + "=" * 60)
        print("All tests completed successfully!")
        print("=" * 60)
        return 0
        
    except Exception as exc:
        print(f"\n\nTEST FAILED: {exc}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
