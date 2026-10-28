package demo;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;
@SpringBootApplication @RestController
public class App {
  public static void main(String[] args) { SpringApplication.run(App.class, args); }
  @GetMapping("/api/health") public String health() { return "{\"status\":\"UP\"}"; }
}
