from .service import PaymentService
from fastapi import APIRouter

router = APIRouter()

@router.get("/payments/{payment_id}")
def get_payment():
    return PaymentService.find()
