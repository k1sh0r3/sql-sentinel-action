-- SQL Sentinel Action demo schema (small e-commerce schema)
CREATE TABLE customers (
  id INT PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(255),
  country VARCHAR(50)
);

CREATE TABLE orders (
  id INT PRIMARY KEY,
  customer_id INT,
  total DECIMAL(10, 2),
  status VARCHAR(20),
  created_at TIMESTAMP
);

CREATE TABLE products (
  id INT PRIMARY KEY,
  name VARCHAR(200),
  price DECIMAL(10, 2)
);

CREATE TABLE refunds (
  id INT PRIMARY KEY,
  order_id INT,
  refund_amount DECIMAL(10, 2)
);
