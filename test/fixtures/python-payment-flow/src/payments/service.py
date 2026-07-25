from .repository import PaymentRepository

class PaymentService:
    def find():
        return PaymentRepository.get()
