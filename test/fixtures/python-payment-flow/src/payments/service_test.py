from payments.service import PaymentService

def service_test():
    assert PaymentService.find() is not None
