from app.routers.agent import FrontDeskRequest, _fallback_frontdesk_response


def test_frontdesk_sensitive_question_asks_before_routing():
    response = _fallback_frontdesk_response(
        FrontDeskRequest(
            utterance="Can you tell me how much money I have in my chequing account?",
            robot_name="ARIA",
            recognised_name="Nirav",
            has_face_match=True,
            has_magic_link=True,
        )
    )

    assert response.intent == "account-help"
    assert response.should_route is False
    assert response.route_target == "none"
    assert "secure" in response.reply.lower()


def test_frontdesk_confirmation_routes_to_magic_link_when_ready():
    response = _fallback_frontdesk_response(
        FrontDeskRequest(
            utterance="yes, go ahead",
            robot_name="ARIA",
            recognised_name="Nirav",
            has_face_match=True,
            has_magic_link=True,
            history=[
                {
                    "role": "agent",
                    "text": "I can help with that, Nirav. Would you like me to open your secure banking session so I can pull up the details?",
                }
            ],
        )
    )

    assert response.should_route is True
    assert response.route_target == "magic_link"


def test_frontdesk_open_account_needs_confirmation_first():
    response = _fallback_frontdesk_response(
        FrontDeskRequest(
            utterance="I want to open a new account for the first time.",
            robot_name="ARIA",
            has_face_match=False,
            has_magic_link=False,
        )
    )

    assert response.intent == "open-account"
    assert response.should_route is False
    assert "onboarding" in response.reply.lower() or "open an account" in response.reply.lower()
