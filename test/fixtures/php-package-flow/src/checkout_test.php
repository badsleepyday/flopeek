<?php

require_once __DIR__ . '/checkout.php';

if (!checkout('test-order')) {
  throw new RuntimeException('checkout failed');
}
