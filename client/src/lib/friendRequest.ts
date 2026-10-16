import { contactRefusalMessage, isContactRefusal } from "./contact";
import { federationRefusalMessage } from "./federation";

/**
 * What a friend request that did not go through comes to, in words, from the answer's error code: shared by the friends page and the
 * directory. `settled` is true when there is nothing more to try (already friends, or a request already waiting), so the box that
 * made the attempt can be cleared.
 */
export function friendRequestFailure(code: string | undefined): { message: string; settled: boolean } {
  if (code === "already_friends") return { message: "You're already friends.", settled: true };
  if (code === "request_already_pending") {
    return { message: "There is already a pending request with them: see the Incoming and Outgoing tabs.", settled: true };
  }
  if (code === "blocked") return { message: "You can't send a request to them.", settled: false };
  if (code === "user_not_found") return { message: "No one with that name was found.", settled: false };
  if (isContactRefusal(code)) return { message: contactRefusalMessage("request"), settled: false };
  return { message: federationRefusalMessage(code) ?? "Couldn't send request.", settled: false };
}
