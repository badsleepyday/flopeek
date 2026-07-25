import { OrdersService } from "./orders.service";

router.post("/orders", OrdersService.create);
