<?php

function checkout(string $orderId): bool {
  return recordCheckout($orderId);
}

function recordCheckout(string $orderId): bool {
  return $orderId !== '';
}

checkout('fixture-order');
