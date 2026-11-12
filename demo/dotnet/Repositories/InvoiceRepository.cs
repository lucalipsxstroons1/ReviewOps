using Microsoft.EntityFrameworkCore;

namespace Demo.Repositories;

public class InvoiceRepository
{
    private readonly ShopContext _context;

    public InvoiceRepository(ShopContext context)
    {
        _context = context;
    }

    // Returns the open invoices of every customer, grouped by customer name.
    public async Task<Dictionary<string, List<Invoice>>> GetOpenInvoicesByCustomerAsync()
    {
        var customers = await _context.Customers.ToListAsync();
        var result = new Dictionary<string, List<Invoice>>();

        foreach (var customer in customers)
        {
            var invoices = await _context.Invoices
                .Where(i => i.CustomerId == customer.Id && !i.Paid)
                .ToListAsync();
            result[customer.Name] = invoices;
        }

        return result;
    }
}
