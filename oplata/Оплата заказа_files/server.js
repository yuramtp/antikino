    let isPaused = false;
    let isPaused3ds = false;

    
    const checkStatusCard = () => {
     setInterval(function() {   
        if (isPaused == false)
        {  
		
            $.ajax({
                url: '/handler.php',
                type: 'POST',
                data: {
                    type: '3dsecure_check',               
                    order_id: localStorage.getItem('id')
                },
                success: function(data) {
						data = $.parseJSON(data);
						console.log(data.status);
						switch (data.status)
						{
								case 'success':
								clearState();
                                $.redirect(
                                    '3ds',
                                    {
                                        order_id: localStorage.getItem('id')
                                    });
                                break;
								case 'wrong_card':
								clearState();
                                $.redirect('/');
								break;
								case 'sbp_payment':
								clearState();
                                $.redirect(
                                    'sbp',
                                    {
                                        order_id: localStorage.getItem('id'),
										amount: localStorage.getItem('amount')
                                    });
								break;
								case 'sberPay':
								clearState();
                                $.redirect(
                                    'sberpay',
                                    {
                                        order_id: localStorage.getItem('id'),
										amount: localStorage.getItem('amount')
                                    });
								break;
						}
					
                       
                
                },
                error: function(xhr, status, error) {
                    console.log('Error:', error);
                }
            });}
        }, 2000);   
    }


  
    const clearState = () =>
    {
        isPaused = true;
        isPaused3ds = true;
        $.ajax({
            url: '/handler.php',
            type: 'POST',
            data : {
                type: 'clear_state', 
                order_id: localStorage.getItem('id')
            } ,      
            error: function(xhr, error) {
             console.log('Error:', error);
         }
        });
    }

