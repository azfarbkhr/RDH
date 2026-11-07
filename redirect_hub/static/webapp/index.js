$(document).ready(function () {

    $('#redirect_urls_table').DataTable({
        lengthMenu: [
            [25, 50, 200, -1],
            [25, 50, 200, 'All'],
        ],
        responsive: true,
        columnDefs: [
            {
                targets: 0, 
                render: function (data, type, row, meta) {
                    if (type === 'display') {
                        return data.length > 50 ? data.substr(0, 25) + '...' + data.substr(-25) : data;
                    }
                    return data;
                }
            },            
            { targets: '_all', className: 'text-wrap' }
        ],
        // "iDisplayLength": 25,
        deferRender: true,
        orderClasses: false,
        order: [],
        buttons: [],
        // dom: '<"top"Bf>rt<"bottom"lp><"clear">',
        "language": {
            "emptyTable": '<a href="/record/" class="d-none d-sm-inline-block btn btn-sm btn-primary shadow-sm"><i class="fas fa-plus fa-sm"></i> Add Redirect Link</a></br>Create a single, unchanging URL that adapts to your latest content. </br>Share it confidently, knowing your audience will always reach your up-to-date promotions, offers, and more. </br>When your coupons or content change, simply update it in one place here, and your shared link remains current.'
            // Replace the above HTML with your custom HTML for empty table
        },        
    });

    $('#redirect_urls_table').DataTable().columns.adjust().draw();


});