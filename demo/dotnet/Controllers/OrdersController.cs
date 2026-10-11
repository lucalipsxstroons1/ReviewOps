using Demo.Repositories;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Demo.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly OrderRepository _orders;

    public OrdersController(OrderRepository orders)
    {
        _orders = orders;
    }

    [HttpGet("{id}")]
    [Authorize]
    public async Task<IActionResult> Get(int id)
    {
        var order = await _orders.FindAsync(id);
        return order is null ? NotFound() : Ok(order);
    }

    [HttpGet("customer/{customerId}")]
    [Authorize]
    public async Task<IActionResult> ListForCustomer(int customerId)
    {
        return Ok(await _orders.ListForCustomerAsync(customerId));
    }
}
