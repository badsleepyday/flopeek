import { OrdersRepository } from "./orders.repository";
import { validateOrder } from "./validation";

export class OrdersService {
  static create() {
    validateOrder();
    return OrdersRepository.save();
  }
}
