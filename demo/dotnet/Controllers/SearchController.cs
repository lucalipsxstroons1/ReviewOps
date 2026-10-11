using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Demo.Controllers;

[ApiController]
[Authorize]
[Route("api/[controller]")]
public class SearchController : ControllerBase
{
    private readonly ShopContext _context;

    public SearchController(ShopContext context)
    {
        _context = context;
    }

    // Finds products whose name contains the search term.
    [HttpGet]
    public async Task<IActionResult> Find(string term)
    {
        var products = await _context.Products
            .FromSqlRaw("SELECT * FROM Products WHERE Name LIKE '%" + term + "%'")
            .ToListAsync();
        return Ok(products);
    }
}
