-- Clean query: safe, limited, known columns
SELECT id, total
FROM orders
WHERE status = 'paid'
ORDER BY total DESC
LIMIT 10;
