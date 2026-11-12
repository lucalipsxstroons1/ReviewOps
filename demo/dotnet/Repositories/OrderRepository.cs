using Demo.Data;
using Demo.Models;
using Microsoft.EntityFrameworkCore;

namespace Demo.Repositories;

public class OrderRepository
{
    private readonly AppDbContext _db;

    public OrderRepository(AppDbContext db)
    {
        _db = db;
    }

    public Task<Order?> FindAsync(int id)
    {
        return _db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.Id == id);
    }

    public Task<List<Order>> ListForCustomerAsync(int customerId)
    {
        return _db.Orders
            .AsNoTracking()
            .Where(o => o.CustomerId == customerId)
            .OrderBy(o => o.Id)
            .ToListAsync();
    }
}
